import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { remoteFindCommand, remoteGrepCommand } from "./search";
import { createRemoteFindOps, runRemoteGrep } from "./remote-ops";
import { localSshFixture } from "./test-helpers";

const posixOnly = { skip: process.platform === "win32" ? "Remote POSIX command harness; Windows client paths tested separately" : false };

test("remote find handles zero-depth globstar, braces and parent .gitignore in a worktree", posixOnly, async (t) => {
	const target = await localSshFixture(t);
	const root = join(target.remoteCwd, "repo");
	await mkdir(join(root, "src", "nested"), { recursive: true });
	execFileSync("git", ["init", `--separate-git-dir=${join(target.remoteCwd, "metadata")}`, root]);
	for (const file of ["src/a.ts", "src/a.tsx", "src/nested/b.ts", "src/hidden.ts", "src/special\nname.ts", "src/readme.md"]) await writeFile(join(root, file), "needle\n");
	await writeFile(join(root, ".gitignore"), "src/hidden.ts\n");
	const find = (pattern: string, searchRoot = root) => JSON.parse(execFileSync("bash", ["-c", remoteFindCommand()], { input: JSON.stringify({ root: searchRoot, pattern, limit: 100 }), encoding: "utf8" }));
	assert.deepEqual(find("src/**/*.ts"), ["src/a.ts", "src/special\nname.ts", "src/nested/b.ts"]);
	assert.deepEqual(find("**/*.{ts,tsx}", join(root, "src")), ["a.ts", "a.tsx", "special\nname.ts", "nested/b.ts"]);
	const ops = createRemoteFindOps({ ...target, remoteCwd: root }, "/virtual");
	const results = await ops.glob("src/**/*.ts", "/virtual", { ignore: [], limit: 100 });
	assert.ok(results.every((path) => path.startsWith("/virtual/src/")));
});

test("grep fallback respects glob/ignore rules, case/literal options and regex failures", posixOnly, async (t) => {
	const target = await localSshFixture(t);
	const root = target.remoteCwd;
	execFileSync("git", ["init", root]);
	await mkdir(join(root, "src"));
	await writeFile(join(root, ".gitignore"), "src/hidden.ts\n");
	await writeFile(join(root, "src", "a.ts"), "Literal[needle]\n");
	await writeFile(join(root, "src", "hidden.ts"), "Literal[needle]\n");
	await writeFile(join(root, "src", "a.md"), "Literal[needle]\n");
	const params = { root, pattern: "literal[needle]", glob: "src/**/*.ts", ignoreCase: true, literal: true };
	const fallback = (payload: typeof params) => spawnSync("bash", ["-c", remoteGrepCommand(payload).replace("command -v rg", "false")], { input: JSON.stringify(payload), encoding: "utf8" });
	const result = fallback(params);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /a\.ts:1:Literal\[needle\]/);
	assert.doesNotMatch(result.stdout, /hidden\.ts|a\.md/);
	assert.equal(fallback({ ...params, literal: false, pattern: "[" }).status, 2);
	assert.equal(fallback({ ...params, pattern: "no match" }).status, 1);
});

test("remote grep reports limits only when output actually exceeds them", posixOnly, async (t) => {
	const target = await localSshFixture(t);
	await writeFile(join(target.remoteCwd, "a.txt"), "needle\nneedle\n");
	const exact = await runRemoteGrep(target, target.remoteCwd, { pattern: "needle", limit: 2 });
	assert.equal(exact.details?.matchLimitReached, undefined);
	const limited = await runRemoteGrep(target, target.remoteCwd, { pattern: "needle", limit: 1 });
	assert.equal(limited.details?.matchLimitReached, 1);
	assert.match(limited.text, /1 results limit reached/);
	await writeFile(join(target.remoteCwd, "a.txt"), `needle${"x".repeat(60 * 1024)}`);
	assert.match((await runRemoteGrep(target, target.remoteCwd, { pattern: "needle" })).text, /Truncated at 51200 bytes/);
});
