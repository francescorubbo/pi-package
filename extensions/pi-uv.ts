import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { addPromptGuideline } from "./prompt-guidelines.js";
import { rewriteCommand } from "./pi-uv-core.js";

// pi extension — routes Python commands through `uv run`.
// Requires: uv in PATH.
//
// The model is asked via the system prompt to invoke Python tools
// (python, pytest, ruff, etc.) as `uv run ...` itself. When it does not,
// this extension rewrites the command before execution and prepends
// `uv run --project <project>` so it still lands in the correct
// uv-managed virtual environment.
//
// Prompt guidance is the primary mechanism: the command the model emits
// is then the command that executes, so tool output matches its intent.
// The `tool_call` rewrite is an enforcement fallback for direct Python
// invocations the model forgot to wrap.
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

const GUIDELINE =
	"Run Python tools (python, python3, pytest, ruff, mypy, black, etc.) through `uv run` so they use the project's uv-managed environment, e.g. `uv run pytest` or `uv run python main.py`. Do not invoke them directly: the pi-uv extension rewrites direct invocations, so otherwise the command that executes differs from the one you emit.";

export default async function (pi: ExtensionAPI) {
	const ver = await pi.exec("uv", ["--version"], {
		timeout: REWRITE_TIMEOUT_MS,
	});
	if (ver.code !== 0) {
		console.warn("[pi-uv] uv binary not found in PATH — extension disabled");
		return;
	}

	pi.on("before_agent_start", (event) => {
		// Mutate the guideline collection so pi patches only the changed prompt
		// section instead of replacing the whole system prompt. The shared helper
		// keeps the order canonical so the section text is stable across turns.
		addPromptGuideline(event.systemPromptOptions.promptGuidelines, GUIDELINE);
	});

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
