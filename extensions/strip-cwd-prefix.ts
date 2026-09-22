import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { stripRedundantCwdPrefix } from "./strip-cwd-prefix-core.js";

// pi extension — stops redundant `cd <cwd> &&` prefixes in bash commands.
//
// Some models prepend `cd <absolute cwd> &&` to nearly every command even
// though the bash tool already runs in that directory. This extension applies
// two mitigations:
//
//   1. Cleanup: before a bash command runs, a leading no-op `cd <cwd>` prefix
//      is stripped. Only prefixes that resolve back to the session cwd are
//      removed, so intentional `cd` into another directory is untouched.
//   2. Prompt: a guideline is added to the system prompt telling the model
//      that bash already starts in the working directory.
//
// The rewriting logic lives in `strip-cwd-prefix-core.ts` so it can be
// unit-tested without importing the pi-coding-agent SDK.

const GUIDELINE =
	"Bash commands already run in the session working directory. Never prefix them with `cd <cwd> &&`; use relative paths instead.";

export default function (pi: ExtensionAPI) {
	let stripped = 0;

	pi.on("before_agent_start", (event) => {
		// Mutate the guideline collection so pi patches only the changed prompt
		// section instead of replacing the whole system prompt.
		if (!event.systemPromptOptions.promptGuidelines.includes(GUIDELINE)) {
			event.systemPromptOptions.promptGuidelines.push(GUIDELINE);
		}
	});

	pi.on("tool_call", (event, ctx) => {
		try {
			if (!isToolCallEventType("bash", event)) return;

			const command = event.input.command;
			const cleaned = stripRedundantCwdPrefix(command, ctx.cwd);
			if (cleaned === null) return;

			event.input.command = cleaned;
			stripped++;
			ctx.ui.setStatus("strip-cwd", `cwd prefix stripped ×${stripped}`);
		} catch (err) {
			console.warn("[strip-cwd-prefix] unexpected error; passing command through", err);
		}
	});
}
