import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../index";
import { runTarTransfer } from "../transfer-native";
import { CONNECTION_TOOLS } from "../tool-activation";
import { resolveTarget } from "./target";
import { runRemoteCommand, closeMaster } from "./transport";
import { startForward, stopForward } from "./forward";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createTcpServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			server.close((error) => error ? reject(error) : resolve(port));
		});
	});
}

test("real OpenSSH: extension activation, file/search tools, native transfers and dedicated forwarding", {
	skip: process.env.PI_SSH_INTEGRATION !== "1" || process.platform !== "linux" ? "Opt in with PI_SSH_INTEGRATION=1 on Linux with /usr/sbin/sshd" : false,
	timeout: 60_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-ssh-real-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const hostKey = join(root, "host");
	const clientKey = join(root, "client key");
	for (const key of [hostKey, clientKey]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
	await copyFile(`${clientKey}.pub`, join(root, "authorized_keys"));
	const port = await freePort();
	const config = join(root, "sshd_config");
	await writeFile(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${join(root, "pid")}\nAuthorizedKeysFile ${join(root, "authorized_keys")}\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nLogLevel ERROR\n`);
	const server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
	let serverError = "";
	server.stderr.on("data", (data) => { serverError += data.toString(); });
	t.after(() => { server.kill(); });
	const remote = `${userInfo().username}@127.0.0.1`;
	const sshOptions = ["-i", clientKey, "-p", String(port), "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(root, "known_hosts")}`, "-o", "ControlMaster=no"];
	const remoteDir = join(root, "remote");
	await mkdir(remoteDir);
	let target;
	for (let attempt = 0; attempt < 20; attempt++) {
		try { target = await resolveTarget(remote, remoteDir, sshOptions); break; }
		catch { if (server.exitCode !== null) throw new Error(serverError); await new Promise((resolve) => setTimeout(resolve, 100)); }
	}
	assert.ok(target, serverError || "SSH server did not become ready");
	t.after(() => closeMaster(target!));
	assert.equal((await runRemoteCommand(target, "printf hello", { login: false })).stdout.toString(), "hello");

	const tools = new Map<string, any>();
	const hooks = new Map<string, Function>();
	let active = ["read", "fffind", "ffgrep"];
	extension({
		registerFlag() {}, registerCommand() {},
		registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); },
		on(name: string, handler: Function) { hooks.set(name, handler); },
		getFlag() {}, getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
		sendMessage() {},
	} as any);
	const toolCtx = { ui: { notify() {}, setStatus() {}, setWidget() {}, theme: { fg: (_color: string, value: string) => value } } };
	await hooks.get("session_start")!({}, toolCtx);
	assert.ok(CONNECTION_TOOLS.every((name) => !active.includes(name)));
	const call = (name: string, params: any) => tools.get(name).execute("test", params, undefined, undefined, toolCtx);
	const destination = `-i '${clientKey}' -p ${port} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${join(root, "known_hosts")} ${remote}:${remoteDir}`;
	await call("ssh_connect", { target: destination, heartbeatEnabled: false });
	t.after(() => hooks.get("session_shutdown")!());
	assert.ok(CONNECTION_TOOLS.every((name) => active.includes(name)));
	await call("ssh_write", { path: "src/file.ts", content: "const needle = 1;\n" });
	assert.match(JSON.stringify(await call("ssh_read", { path: "src/file.ts" })), /needle/);
	assert.match(JSON.stringify(await call("ssh_find", { pattern: "src/**/*.ts" })), /src\/file.ts/);
	assert.match(JSON.stringify(await call("ssh_grep", { pattern: "needle", glob: "**/*.ts" })), /needle/);
	await call("ssh_edit", { path: "src/file.ts", edits: [{ oldText: "needle = 1", newText: "needle = 2" }] });
	assert.match(await readFile(join(remoteDir, "src", "file.ts"), "utf8"), /needle = 2/);
	await call("ssh_connect", { target: destination, fresh: true, heartbeatEnabled: false });
	assert.ok(active.includes("ssh_read"));
	await assert.rejects(call("ssh_connect", { target: destination.replace(`:${remoteDir}`, ":/not-a-real-directory") }), /SSH failed/);
	assert.ok(active.includes("ssh_read"), "failed switch must retain current tools");
	await call("ssh_disconnect", {});
	assert.ok(CONNECTION_TOOLS.every((name) => !active.includes(name)));
	assert.ok(active.includes("fffind") && active.includes("ffgrep"));

	const source = join(root, "source");
	await mkdir(source);
	const binary = Buffer.from([0, 255, 1, 128]);
	await writeFile(join(source, "binary.bin"), binary);
	await runTarTransfer(root, target, source, `${remote}:${remoteDir}/upload/`, {});
	await runTarTransfer(root, target, `${remote}:${remoteDir}/upload/binary.bin`, join(root, "download.bin"), {});
	assert.deepEqual(await readFile(join(root, "download.bin")), binary);

	const http = createServer((_req, res) => res.end("forwarded"));
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	t.after(() => { http.close(); });
	const localPort = await freePort();
	const forward = await startForward(target, `${localPort}:127.0.0.1:${(http.address() as any).port}`, () => {});
	t.after(() => stopForward(forward));
	assert.equal(await (await fetch(`http://127.0.0.1:${localPort}`)).text(), "forwarded");
	await stopForward(forward);
	await assert.rejects(fetch(`http://127.0.0.1:${localPort}`));
});
