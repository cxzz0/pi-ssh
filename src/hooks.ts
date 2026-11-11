// ---------------------------------------------------------------------------
// Session hooks: startup --ssh flag, teardown, and the local-tools reminder
// ---------------------------------------------------------------------------

import type { SshContext } from "./context";
import { startStaleSocketSweep } from "./ssh/sweep";

export function setupHooks(ctx: SshContext): void {
	const { pi, switchTarget, connectedText, refreshStatus, disconnect, getTarget } = ctx;

	// --- startup flag ---
	pi.on("session_start", async (_event, toolCtx) => {
		ctx.updateToolActivation(!!getTarget());
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			try {
				const next = await switchTarget(arg);
				toolCtx.ui.notify(connectedText(next), "info");
			} catch (e) {
				toolCtx.ui.notify(`SSH connect failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		}
		refreshStatus(toolCtx);
		startStaleSocketSweep(getTarget()?.socket);
	});

	// --- teardown ---
	pi.on("session_shutdown", async () => {
		await disconnect();
	});

	// --- remind the agent that local tools stay local ---
	pi.on("before_agent_start", async (event) => {
		const t = getTarget();
		ctx.updateToolActivation(!!t);
		if (!t) return;
		const guidance = `\n\nSSH remote connected: ${t.remote}:${t.remoteCwd}. Local tools (including fffind/ffgrep) stay local; use ssh_* tools for remote operations.`;
		return { systemPrompt: event.systemPrompt + guidance };
	});
}
