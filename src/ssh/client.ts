// Keep every SSH operation on the same client and authentication agent.
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export function resolveSshExecutable(opts: {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
} = {}): string {
	const platform = opts.platform ?? process.platform;
	const env = opts.env ?? process.env;
	const override = env.PI_SSH_EXECUTABLE?.trim();
	if (override) return override;
	if (platform === "win32") {
		// Git for Windows may put its MSYS ssh ahead of Windows OpenSSH on
		// PATH. That client does not use the Windows ssh-agent service.
		const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
		if (root) {
			const native = win32.join(root, "System32", "OpenSSH", "ssh.exe");
			if ((opts.exists ?? existsSync)(native)) return native;
		}
	}
	return "ssh";
}
