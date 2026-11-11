import assert from "node:assert/strict";
import { test } from "node:test";
import { posix, win32 } from "node:path";
import { tokenizeSshArgs, toRemotePath } from "./utils";

test("Windows connection arguments preserve drive paths, backslashes and spaces", () => {
	assert.deepEqual(tokenizeSshArgs('-i "C:\\Users\\Alice Smith\\.ssh\\id_ed25519" me@host:/work', "win32"), ["-i", "C:\\Users\\Alice Smith\\.ssh\\id_ed25519", "me@host:/work"]);
	assert.deepEqual(tokenizeSshArgs('-i C:\\keys\\id --env FOO=bar me@host', "win32"), ["-i", "C:\\keys\\id", "--env", "FOO=bar", "me@host"]);
	assert.deepEqual(tokenizeSshArgs("-i /tmp/my\\ key host", "linux"), ["-i", "/tmp/my key", "host"]);
	assert.throws(() => tokenizeSshArgs('-i "unfinished', "win32"), /Unclosed quote/);
});

test("Windows workspace paths map to POSIX remote paths", () => {
	const remote = (p: string) => toRemotePath(p, "C:\\Users\\Alice\\repo", "/work", "/home/alice", win32);
	assert.equal(remote("src\\index.ts"), "/work/src/index.ts");
	assert.equal(remote("C:\\Users\\Alice\\repo\\src\\index.ts"), "/work/src/index.ts");
	assert.equal(remote("/etc/profile"), "/etc/profile");
	assert.equal(remote("C:\\etc\\profile"), "/etc/profile");
	assert.equal(remote("~/.profile"), "/home/alice/.profile");
	assert.equal(remote("..cache\\file"), "/work/..cache/file");
	assert.throws(() => remote("..\\outside"), /outside workspace/);
	assert.throws(() => remote("\\\\server\\share\\outside"), /UNC/);
	assert.equal(toRemotePath("src/main.ts", "/local", "/", undefined, posix), "/src/main.ts");
});
