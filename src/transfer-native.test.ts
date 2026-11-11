import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTarTransfer } from "./transfer-native";
import type { SshTarget } from "./types";
import { localSshFixture } from "./test-helpers";

test("native tar dry-run uses Git ignore rules without creating a repository or remote files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-ssh transfer "));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, ".gitignore"), "*.log\n!keep.log\n");
	await writeFile(join(root, "skip.log"), "skip");
	await writeFile(join(root, "keep.log"), "keep");
	await writeFile(join(root, "file with spaces.txt"), "keep");
	const target = { remote: "fixture", socket: "unused", sshOptions: [] } as unknown as SshTarget;
	const result = await runTarTransfer(root, target, root, "fixture:/not-created", { dryRun: true, gitignore: true, verbose: true });
	assert.match(result.stdout, /keep\.log/);
	assert.match(result.stdout, /file with spaces\.txt/);
	assert.doesNotMatch(result.stdout, /skip\.log/);
	await assert.rejects(stat(join(root, ".git")), { code: "ENOENT" });
	await assert.rejects(runTarTransfer(root, target, root, "fixture:/not-created", { delete: true }), /delete:true is not supported/);
});

test("native tar transfers directories and renamed binary files over the SSH command harness", { skip: process.platform === "win32" ? "POSIX remote harness; native Windows tar dry-run runs above" : false }, async (t) => {
	const target = await localSshFixture(t);
	const root = target.remoteCwd;
	const source = join(root, "source");
	const remote = join(root, "remote");
	const pulled = join(root, "pulled");
	await mkdir(source);
	const bytes = Buffer.from([0, 255, 13, 10, 128]);
	await writeFile(join(source, "binary file.bin"), bytes);
	await writeFile(join(source, "excluded.tmp"), "exclude");
	await runTarTransfer(root, target, source, `fixture:${remote}/`, { excludes: ["*.tmp"] });
	assert.deepEqual(await readFile(join(remote, "binary file.bin")), bytes);
	await assert.rejects(stat(join(remote, "excluded.tmp")), { code: "ENOENT" });
	await runTarTransfer(root, target, `fixture:${remote}/`, pulled, {});
	assert.deepEqual(await readFile(join(pulled, "binary file.bin")), bytes);
	await runTarTransfer(root, target, join(source, "binary file.bin"), `fixture:${remote}/renamed.bin`, {});
	await runTarTransfer(root, target, `fixture:${remote}/renamed.bin`, join(pulled, "renamed again.bin"), {});
	assert.deepEqual(await readFile(join(pulled, "renamed again.bin")), bytes);
});
