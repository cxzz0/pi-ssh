import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { SshTarget } from "./types";

export async function localSshFixture(test: TestContext): Promise<SshTarget> {
	const root = await mkdtemp(join(tmpdir(), "pi-ssh-fixture-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	const ssh = join(bin, "ssh");
	await writeFile(ssh, '#!/bin/sh\nfor arg do command=$arg; done\nexec /bin/bash -c "$command"\n');
	await chmod(ssh, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath}`;
	test.after(async () => { process.env.PATH = originalPath; await rm(root, { recursive: true, force: true }); });
	return { remote: "fixture", remoteCwd: root, remoteHome: root, socket: "unused", hasPython: true, sshOptions: [], loginShell: "/bin/bash", shellKind: "bash" };
}
