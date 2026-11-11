import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { SshTarget } from "./types";
import { runLocalProcess } from "./transfer";
import { remoteShell, runRemoteCommand, sshConnArgs, sshFailureMessage } from "./ssh/transport";
import { shQuote } from "./utils";

export interface NativeTransferOptions {
	delete?: boolean;
	dryRun?: boolean;
	excludes?: string[];
	gitignore?: boolean;
	quiet?: boolean;
	verbose?: boolean;
}

// Archives stay on disk, not in runSsh's buffered stdout/stdin, so large syncs
// do not require memory proportional to the transferred workspace.
async function archiveProcess(command: string, args: string[], cwd: string, signal?: AbortSignal, input?: string, output?: string): Promise<void> {
	if (signal?.aborted) throw new Error("aborted");
	const child = spawn(command, args, { cwd, stdio: [input ? "pipe" : "ignore", output ? "pipe" : "ignore", "pipe"], windowsHide: true });
	let stderr = "";
	child.stderr!.on("data", (data) => { stderr = (stderr + data.toString()).slice(-8192); });
	const abort = () => { child.kill(); };
	signal?.addEventListener("abort", abort, { once: true });
	const exited = new Promise<void>((resolve, reject) => {
		child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new Error(`${command} not found. Windows transfers require OpenSSH, tar.exe and Git on PATH.`) : error));
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(signal?.aborted ? "aborted" : `${command} failed (${code}): ${stderr.trim()}`)));
	});
	try {
		await Promise.all([
			exited,
			...(input ? [pipeline(createReadStream(input), child.stdin!)] : []),
			...(output ? [pipeline(child.stdout!, createWriteStream(output))] : []),
		]);
	} catch (e) {
		child.kill();
		await exited.catch(() => {});
		throw e;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}

async function pushManifest(root: string, temp: string, signal?: AbortSignal): Promise<string[]> {
	let result = await runLocalProcess(root, "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], signal);
	if (result.code !== 0) {
		// Git can evaluate nested .gitignore files outside a repository too,
		// using an isolated index instead of creating .git in the workspace.
		const gitDir = join(temp, "ignore.git");
		const init = await runLocalProcess(root, "git", ["init", "--bare", gitDir], signal);
		if (init.code !== 0) throw new Error(init.stderr.toString());
		result = await runLocalProcess(root, "git", [`--git-dir=${gitDir}`, `--work-tree=${root}`, "ls-files", "-z", "--others", "--exclude-standard", "--", "."], signal);
	}
	if (result.code !== 0) throw new Error(`Could not evaluate .gitignore: ${result.stderr.toString().trim()}`);
	const entries: string[] = [];
	for (const entry of new Set(result.stdout.toString().split("\0").filter(Boolean))) {
		try { await lstat(join(root, entry)); entries.push(entry); }
		catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
	}
	return entries;
}

export async function runTarTransfer(localCwd: string, t: SshTarget, source: string, dest: string, opts: NativeTransferOptions, signal?: AbortSignal, onData?: (chunk: Buffer) => void): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
	if (opts.delete) throw new Error("delete:true is not supported by native Windows tar transfers. Use a non-deleting sync or run pi with rsync in WSL.");
	const started = Date.now();
	const temp = await mkdtemp(join(tmpdir(), "pi-ssh-transfer-"));
	const archive = join(temp, "transfer.tar");
	const excludes = (opts.excludes ?? []).flatMap((pattern) => ["--exclude", pattern]);
	try {
		const prefix = `${t.remote}:`;
		const pulling = source.startsWith(prefix);
		let directory: boolean;
		let fileName: string;
		let remoteDest = "";
		if (!pulling) {
			if (!dest.startsWith(prefix)) throw new Error("Expected an SSH transfer destination");
			const localSource = resolve(localCwd, source);
			directory = (await lstat(localSource)).isDirectory();
			fileName = basename(localSource);
			remoteDest = dest.slice(prefix.length);
			const root = directory ? localSource : dirname(localSource);
			const args = ["-cf", archive, "-C", root, ...excludes, "--exclude", ".git"];
			if (directory && opts.gitignore) {
				const entries = await pushManifest(root, temp, signal);
				const manifest = join(temp, "files");
				await writeFile(manifest, entries.length ? `${entries.join("\0")}\0` : "");
				args.push("--no-recursion", "--null", "-T", manifest);
			} else args.push("--", directory ? "." : fileName);
			await archiveProcess("tar", args, localCwd, signal);
		} else {
			const remoteSource = source.slice(prefix.length).replace(/\/+$/, "") || "/";
			const kind = await runRemoteCommand(t, `if [ -d ${shQuote(remoteSource)} ]; then printf d; elif [ -f ${shQuote(remoteSource)} ]; then printf f; else exit 44; fi`, { login: false, signal });
			if (kind.code !== 0) throw new Error(`${sshFailureMessage(kind)}: ${kind.stderr.toString().trim() || remoteSource}`);
			directory = kind.stdout.toString() === "d";
			fileName = posix.basename(remoteSource);
			const args = ["-cf", "-", "-C", directory ? remoteSource : posix.dirname(remoteSource), ...excludes, "--", directory ? "." : fileName];
			await archiveProcess("ssh", [...sshConnArgs(t), remoteShell(t, `tar ${args.map(shQuote).join(" ")}`, false)], localCwd, signal, undefined, archive);
		}
		const listing = await runLocalProcess(localCwd, "tar", ["-tf", archive], signal);
		if (listing.code !== 0) throw new Error(`Could not read tar archive: ${listing.stderr.toString().trim()}`);
		const files = listing.stdout.toString().trim();
		if (!opts.dryRun) {
			if (!pulling) {
				let command: string;
				if (directory) command = `mkdir -p -- ${shQuote(remoteDest)} && tar -xf - -C ${shQuote(remoteDest)}`;
				else {
					const target = remoteDest.endsWith("/") ? posix.join(remoteDest, fileName) : remoteDest;
					command = `stage=$(mktemp -d) && trap 'rm -rf -- "$stage"' EXIT && tar -xf - -C "$stage" && mkdir -p -- ${shQuote(posix.dirname(target))} && mv -- "$stage"/${shQuote(fileName)} ${shQuote(target)}`;
				}
				await archiveProcess("ssh", [...sshConnArgs(t), remoteShell(t, command, false)], localCwd, signal, archive);
			} else if (directory) {
				await mkdir(dest, { recursive: true });
				await archiveProcess("tar", ["-xf", archive, "-C", dest], localCwd, signal);
			} else {
				const extract = join(temp, "extract");
				await mkdir(extract);
				await archiveProcess("tar", ["-xf", archive, "-C", extract], localCwd, signal);
				const target = dest.endsWith("/") ? join(dest, fileName) : dest;
				await mkdir(dirname(target), { recursive: true });
				await copyFile(join(extract, fileName), target);
			}
		}
		const summary = `${opts.dryRun ? "Would transfer" : "Transferred"} ${files ? files.split("\n").length : 0} archive entries via tar over SSH`;
		const stdout = opts.verbose ? `${summary}\n${files}` : summary;
		if (!opts.quiet) onData?.(Buffer.from(stdout));
		return { stdout: opts.quiet ? "" : stdout, stderr: "", elapsedMs: Date.now() - started };
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
