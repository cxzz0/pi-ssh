import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONNECTION_TOOLS = [
	"ssh_disconnect", "ssh_read", "ssh_ls", "ssh_find", "ssh_grep", "ssh_write",
	"ssh_secret_write", "ssh_edit", "ssh_bash", "ssh_process", "ssh_monitor",
	"ssh_push", "ssh_pull", "ssh_sync", "ssh_tunnel",
] as const;

export function createToolActivation(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {
	let hidden: string[] = [];
	return (connected: boolean): void => {
		const active = pi.getActiveTools();
		if (!connected) {
			const required = new Set<string>(CONNECTION_TOOLS);
			hidden = [...new Set([...hidden, ...active.filter((name) => required.has(name))])];
			pi.setActiveTools(active.filter((name) => !required.has(name)));
		} else if (hidden.length) {
			pi.setActiveTools([...new Set([...active, ...hidden])]);
			hidden = [];
		}
	};
}
