import assert from "node:assert/strict";
import { test } from "node:test";
import { setupHooks } from "./hooks";

test("disconnected hooks add no SSH system prompt and hide tools before startup connection", async () => {
	const hooks = new Map<string, Function>();
	let connected = false;
	const calls: boolean[] = [];
	setupHooks({
		pi: { on: (name: string, handler: Function) => hooks.set(name, handler), getFlag: () => undefined },
		getTarget: () => connected ? { remote: "host", remoteCwd: "/work" } : null,
		updateToolActivation: (value: boolean) => calls.push(value),
		refreshStatus: () => {}, disconnect: async () => {},
	} as any);
	assert.equal(await hooks.get("before_agent_start")!({ systemPrompt: "original" }), undefined);
	await hooks.get("session_start")!({}, {});
	assert.deepEqual(calls, [false, false]);
	connected = true;
	const result = await hooks.get("before_agent_start")!({ systemPrompt: "original" });
	assert.match(result.systemPrompt, /original/);
	assert.match(result.systemPrompt, /fffind\/ffgrep.*stay local/);
	assert.deepEqual(calls, [false, false, true]);
});
