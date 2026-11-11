import assert from "node:assert/strict";
import { test } from "node:test";
import { win32 } from "node:path";
import { resolveSshExecutable } from "./client";
import { formatSshFailure } from "./transport";
import type { RunResult } from "../types";

test("Windows prefers system OpenSSH over Git SSH on PATH", () => {
	const native = win32.join("C:/Windows", "System32", "OpenSSH", "ssh.exe");
	const checked: string[] = [];
	assert.equal(resolveSshExecutable({ platform: "win32", env: { SystemRoot: "C:/Windows" }, exists: (path) => { checked.push(path); return true; } }), native);
	assert.deepEqual(checked, [native]);
	assert.equal(resolveSshExecutable({ platform: "win32", env: { WINDIR: "D:/Windows" }, exists: () => true }), win32.join("D:/Windows", "System32", "OpenSSH", "ssh.exe"));
});

test("SSH executable override takes precedence and preserves spaces", () => {
	for (const platform of ["win32", "linux", "darwin"] as const) {
		assert.equal(resolveSshExecutable({ platform, env: { PI_SSH_EXECUTABLE: "C:/Custom SSH/ssh.exe" }, exists: () => { throw new Error("must not probe"); } }), "C:/Custom SSH/ssh.exe");
	}
});

test("SSH resolver falls back to PATH without Windows OpenSSH and leaves Unix unchanged", () => {
	assert.equal(resolveSshExecutable({ platform: "win32", env: { SystemRoot: "C:/Windows" }, exists: () => false }), "ssh");
	assert.equal(resolveSshExecutable({ platform: "win32", env: {} }), "ssh");
	for (const platform of ["linux", "darwin"] as const) {
		assert.equal(resolveSshExecutable({ platform, env: { SystemRoot: "C:/Windows" }, exists: () => { throw new Error("must not probe"); } }), "ssh");
	}
});

const failure = (patch: Partial<RunResult> = {}): RunResult => ({
	code: 255, signal: null, timedOut: false, stdout: Buffer.alloc(0),
	stderr: Buffer.from("user@host: Permission denied (publickey,password)."), ...patch,
});

test("authentication failures explain non-interactive encrypted-key authentication", () => {
	const message = formatSshFailure(failure(), "win32");
	assert.match(message, /^SSH failed \(255\): user@host: Permission denied/);
	assert.match(message, /BatchMode=yes/);
	assert.match(message, /If your key is encrypted/);
	assert.match(message, /Windows ssh-agent service/);
	assert.match(message, /Git\/WSL agents are separate/);
	assert.doesNotMatch(formatSshFailure(failure(), "linux"), /Windows/);
});

test("unrelated, timed-out and signaled failures do not suggest loading keys", () => {
	assert.equal(formatSshFailure(failure({ code: 1, stderr: Buffer.from("command failed") })), "SSH failed (1): command failed");
	assert.equal(formatSshFailure(failure({ stderr: Buffer.from("Host key verification failed.") })), "SSH failed (255): Host key verification failed.");
	assert.doesNotMatch(formatSshFailure(failure({ timedOut: true })), /ssh-add/);
	assert.doesNotMatch(formatSshFailure(failure({ signal: "SIGTERM" })), /ssh-add/);
});
