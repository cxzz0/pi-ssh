import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../index";
import { CONNECTION_TOOLS } from "../tool-activation";
import { runTarTransfer } from "../transfer-native";
import { shQuote } from "../utils";
import { runSshDoctor } from "../doctor";
import { resolveSshExecutable } from "./client";
import { startForward, stopForward } from "./forward";
import { resolveTarget } from "./target";
import { runRemoteCommand } from "./transport";

test("native Windows SSH: config identity, tools, transfers and forwarding against WSL", {
	skip: process.platform !== "win32" || !process.env.PI_SSH_WINDOWS_TARGET ? "Opt in on Windows with PI_SSH_WINDOWS_TARGET=wsl (POSIX host, key auth, Python and tar required)" : false,
	timeout: 90_000,
}, async (t) => {
	const host = process.env.PI_SSH_WINDOWS_TARGET!;
	const local = await mkdtemp(join(tmpdir(), "pi-ssh-windows-"));
	t.after(() => rm(local, { recursive: true, force: true }));
	const target = await resolveTarget(host);
	const temp = await runRemoteCommand(target, "mktemp -d /tmp/pi-ssh-windows-XXXXXXXX", { login: false });
	assert.equal(temp.code, 0, temp.stderr.toString());
	const remote = temp.stdout.toString().trim();
	assert.match(remote, /^\/tmp\/pi-ssh-windows-[A-Za-z0-9]+$/);
	target.remoteCwd = remote;
	t.after(async () => {
		const result = await runRemoteCommand(target, `rm -rf -- ${shQuote(remote)}`, { login: false });
		assert.equal(result.code, 0, result.stderr.toString());
	});
	const doctor = await runSshDoctor(target);
	assert.ok(doctor.includes(`SSH client: ${resolveSshExecutable()}`));
	assert.match(doctor, /IdentityFile:/);

	// Exercise the same extension connection/tool paths as /ssh, including
	// a real config filename containing spaces and the host's IdentityFile.
	const config = join(local, "ssh config with spaces");
	await writeFile(config, `Include "${join(process.env.USERPROFILE!, ".ssh", "config").replaceAll("\\", "/")}"\n`);
	const destination = `-F "${config}" ${host}:${remote}`;
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
	const ctx = { ui: { notify() {}, setStatus() {}, setWidget() {}, theme: { fg: (_color: string, value: string) => value } } };
	await hooks.get("session_start")!({}, ctx);
	t.after(() => hooks.get("session_shutdown")!());
	const call = (name: string, params: any) => tools.get(name).execute("test", params, undefined, undefined, ctx);
	await call("ssh_connect", { target: destination, heartbeatEnabled: false });
	assert.ok(CONNECTION_TOOLS.every((name) => active.includes(name)));
	await call("ssh_write", { path: "src/file.ts", content: "const needle = 1;\n" });
	assert.match(JSON.stringify(await call("ssh_read", { path: "src/file.ts" })), /needle/);
	assert.match(JSON.stringify(await call("ssh_find", { pattern: "src/**/*.ts" })), /file\.ts/);
	assert.match(JSON.stringify(await call("ssh_grep", { pattern: "needle", glob: "**/*.ts" })), /needle/);
	await call("ssh_edit", { path: "src/file.ts", edits: [{ oldText: "needle = 1", newText: "needle = 2" }] });
	assert.match(JSON.stringify(await call("ssh_bash", { command: "cat src/file.ts" })), /needle = 2/);
	await call("ssh_connect", { target: destination, fresh: true, heartbeatEnabled: false });
	await call("ssh_disconnect", {});
	assert.ok(CONNECTION_TOOLS.every((name) => !active.includes(name)));
	assert.ok(active.includes("fffind") && active.includes("ffgrep"));

	const source = join(local, "binary source");
	await mkdir(source);
	const binary = Buffer.from([0, 255, 1, 128, 10, 13]);
	await writeFile(join(source, "binary.bin"), binary);
	await runTarTransfer(local, target, source, `${host}:${remote}/upload/`, {});
	const download = join(local, "renamed binary.bin");
	await runTarTransfer(local, target, `${host}:${remote}/upload/binary.bin`, download, {});
	assert.deepEqual(await readFile(download), binary);

	// Forward back to the remote's SSH listener and read its banner. No
	// remote test server or reverse-forwarding permission is needed.
	const connection = await runRemoteCommand(target, "printf '%s' \"$SSH_CONNECTION\"", { login: false });
	assert.equal(connection.code, 0, connection.stderr.toString());
	const remotePort = Number(connection.stdout.toString().trim().split(/\s+/).pop());
	assert.ok(remotePort > 0 && remotePort <= 65535);
	const portProbe = createServer();
	await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
	const localPort = (portProbe.address() as { port: number }).port;
	await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
	const forward = await startForward(target, `${localPort}:127.0.0.1:${remotePort}`, () => {});
	t.after(() => stopForward(forward));
	const banner = () => new Promise<string>((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port: localPort });
		socket.once("data", (data) => { socket.destroy(); resolve(data.toString()); });
		socket.once("error", reject);
		socket.once("end", () => reject(new Error("tunnel closed before SSH banner")));
		socket.setTimeout(5000, () => socket.destroy(new Error("SSH banner timeout")));
	});
	assert.match(await banner(), /^SSH-2\.0-/);
	await stopForward(forward);
	await assert.rejects(banner());
});
