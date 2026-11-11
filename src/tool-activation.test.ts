import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTION_TOOLS, createToolActivation } from "./tool-activation";

test("hide exactly 15 connection tools, preserving local tools and user selections", () => {
	let active = ["read", "fffind", "ffgrep", "ssh_connect", "ssh_status", ...CONNECTION_TOOLS];
	const update = createToolActivation({ getActiveTools: () => active, setActiveTools: (names) => { active = names; } });
	assert.equal(CONNECTION_TOOLS.length, 15);
	update(false);
	assert.deepEqual(active, ["read", "fffind", "ffgrep", "ssh_connect", "ssh_status"]);
	update(false);
	active.push("other_extension");
	update(true);
	assert.equal(new Set(active).size, active.length);
	assert.ok(CONNECTION_TOOLS.every((name) => active.includes(name)));
	assert.ok(active.includes("other_extension"));
	active = active.filter((name) => name !== "ssh_grep");
	update(false);
	update(true);
	assert.ok(!active.includes("ssh_grep"));
});
