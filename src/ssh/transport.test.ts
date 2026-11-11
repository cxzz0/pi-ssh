import { test } from "node:test";
import assert from "node:assert/strict";
import { baseSshOptions, createCloseGuard, isTransportSuccessAfterRetry, supportsMultiplexing, wrapForShell } from "./transport";
import { forwardArgs } from "./forward";
import { spawnSync } from "node:child_process";
import type { RunResult } from "../types";

test("native Windows SSH options never enable unsupported multiplexing", () => {
	assert.equal(supportsMultiplexing("win32"), false);
	assert.equal(supportsMultiplexing("linux"), true);
	assert.equal(supportsMultiplexing("darwin"), true);
	const args = baseSshOptions("C:\\Temp\\pi.sock", "win32");
	assert.ok(!args.some((arg) => /Control|\.sock|-O/.test(arg)));
	assert.ok(baseSshOptions("/tmp/pi.sock", "linux").includes("ControlMaster=auto"));
	const config = spawnSync("ssh", ["-G", ...args, "example.invalid"], { encoding: "utf8" });
	assert.equal(config.status, 0, config.stderr || config.error?.message || "ssh -G failed");
});

test("Windows forwards use a dedicated foreground process with fail-fast binding", () => {
	const args = forwardArgs({ remote: "user@host", socket: "unused", sshOptions: ["-i", "C:\\Keys\\my key"] } as any, "8080:127.0.0.1:80");
	assert.ok(args.includes("-N"));
	assert.ok(args.includes("ExitOnForwardFailure=yes"));
	assert.ok(args.includes("127.0.0.1:8080:127.0.0.1:80"));
	assert.ok(!args.some((arg) => /Control|-O/.test(arg)));
	assert.equal(args[1], "C:\\Keys\\my key");
});

test("createCloseGuard merges in-flight closes for the same socket", async () => {
	let release!: () => void;
	let calls = 0;
	const guard = createCloseGuard();
	const p1 = guard("sock", { reason: "retry" }, async () => {
		calls++;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	const p2 = guard("sock", { reason: "retry" }, async () => {
		calls++;
	});
	assert.equal(p2, p1);
	assert.equal(calls, 1);
	release();
	assert.equal(await p1, true);
	assert.equal(await p2, true);
});

test("createCloseGuard debounces only retry cleanup", async () => {
	let now = 1_000;
	let calls = 0;
	const guard = createCloseGuard(() => now);
	const close = async () => {
		calls++;
	};

	assert.equal(await guard("sock", { reason: "retry" }, close), true);
	assert.equal(calls, 1);
	now += 1_999;
	assert.equal(await guard("sock", { reason: "retry" }, close), false);
	assert.equal(calls, 1);
	assert.equal(await guard("sock", {}, close), true);
	assert.equal(calls, 2);
	now += 1;
	assert.equal(await guard("sock", { reason: "retry" }, close), true);
	assert.equal(calls, 3);
});

test("isTransportSuccessAfterRetry distinguishes command failure from transport failure", () => {
	const result = (patch: Partial<RunResult>): RunResult => ({
		code: 0,
		signal: null,
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		timedOut: false,
		...patch,
	});
	assert.equal(isTransportSuccessAfterRetry(result({ code: 0 })), true);
	assert.equal(isTransportSuccessAfterRetry(result({ code: 1 })), true);
	assert.equal(isTransportSuccessAfterRetry(result({ code: 255, stderr: Buffer.from("mux_client_request_session failed") })), false);
	assert.equal(isTransportSuccessAfterRetry(result({ timedOut: true })), false);
	assert.equal(isTransportSuccessAfterRetry(result({ signal: "SIGTERM" })), false);
});

test("wrapForShell keeps bash parsing under zsh login startup", () => {
	assert.equal(wrapForShell("bash", true, "echo hi"), "bash -lc 'echo hi'");
	assert.equal(wrapForShell("other", true, "echo hi"), "bash -lc 'echo hi'");
	assert.equal(wrapForShell("bash", false, "echo hi"), "bash -c 'echo hi'");
	assert.equal(wrapForShell("zsh", true, "echo hi"), "zsh -ilc 'exec bash -c '\\''echo hi'\\'''");
	assert.match(wrapForShell("zsh", true, "printf '%s\\n' hi"), /^zsh -ilc 'exec bash -c /);
});
