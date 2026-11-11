import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { SshTarget } from "../types";
import { baseSshOptions } from "./transport";

export function forwardArgs(t: SshTarget, spec: string): string[] {
	return [...t.sshOptions, ...baseSshOptions(t.socket, "win32"), "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${spec}`, "--", t.remote];
}

export async function startForward(t: SshTarget, spec: string, onExit: () => void): Promise<ChildProcess> {
	const port = Number(spec.split(":")[0]);
	await new Promise<void>((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
	});
	const child = spawn("ssh", forwardArgs(t, spec), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
	let stderr = "";
	let failure: Error | undefined;
	child.stderr!.on("data", (data) => { stderr = (stderr + data.toString()).slice(-4096); });
	child.on("error", (error) => { failure = error; });
	child.on("close", (code) => { failure ??= new Error(stderr.trim() || `SSH tunnel exited (${code})`); onExit(); });
	const deadline = Date.now() + 10_000;
	try {
		while (Date.now() < deadline) {
			if (failure) throw failure;
			const ready = await new Promise<boolean>((resolve) => {
				const socket = createConnection({ host: "127.0.0.1", port });
				const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
				socket.once("connect", () => done(true));
				socket.once("error", () => done(false));
				socket.setTimeout(200, () => done(false));
			});
			if (ready && !failure) return child;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`SSH tunnel did not bind localhost:${port} within 10s`);
	} catch (e) {
		await stopForward(child);
		throw e;
	}
}

export function stopForward(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
		child.once("close", () => { clearTimeout(timer); resolve(); });
		child.kill();
	});
}
