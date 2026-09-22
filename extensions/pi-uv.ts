import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { rewriteCommand } from "./pi-uv-core.js";

// pi extension — auto-rewrites Python commands to use `uv run`.
// Requires: uv in PATH.
//
// Detects Python-related commands (python, pytest, ruff, etc.) and
// prepends `uv run --project <project>` so they execute inside the
// correct uv-managed virtual environment.
//
// Command detection is delegated to `shell-command-parser.ts`, which
// tokenizes the command with source offsets while respecting quoting,
// separators, redirections and heredocs. This lets us find Python tools
// anywhere in a compound command, including path-qualified invocations
// such as `.venv/bin/python` or `/usr/bin/python3`.
//
// The rewriting logic lives in `pi-uv-core.ts` so it can be unit-tested
// without importing the pi-coding-agent SDK.

const REWRITE_TIMEOUT_MS = 2_000;

export default async function (pi: ExtensionAPI) {
	const ver = await pi.exec("uv", ["--version"], {
		timeout: REWRITE_TIMEOUT_MS,
	});
	if (ver.code !== 0) {
		console.warn("[pi-uv] uv binary not found in PATH — extension disabled");
		return;
	}

	pi.on("tool_call", (event: any, ctx: any) => {
		try {
			if (!isToolCallEventType("bash", event)) return;

			const cmd = event.input.command;
			if (typeof cmd !== "string" || cmd.trim() === "") return;

			const rewritten = rewriteCommand(cmd, ctx.cwd);
			if (rewritten && rewritten !== cmd) {
				event.input.command = rewritten;
				ctx.ui.notify(`[pi-uv] ${rewritten}`, "info");
			}
		} catch (err) {
			console.warn(
				"[pi-uv] unexpected error in tool_call handler; passing through command",
				err,
			);
		}
	});
}
