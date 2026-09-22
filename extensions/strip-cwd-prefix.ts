import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { addPromptGuideline } from "./prompt-guidelines.js";
import { REMOTE_CWD_CHANNEL, type RemoteCwdEvent } from "./remote-cwd.js";
import { stripRedundantCwdPrefix } from "./strip-cwd-prefix-core.js";

// pi extension — stops redundant `cd <cwd> &&` prefixes in bash commands.
//
// Some models prepend `cd <absolute cwd> &&` to nearly every command even
// though the bash tool already runs in that directory. This extension applies
// two mitigations:
//
//   1. Cleanup: before a bash command runs, a leading no-op `cd <cwd>` prefix
//      is stripped. Only prefixes that resolve back to the session cwd are
//      removed, so intentional `cd` into another directory is untouched. When
//      the ssh extension is active, the remote cwd is accepted too (see
//      `remote-cwd.ts`).
//   2. Prompt: a guideline is added to the system prompt telling the model
//      that bash already starts in the working directory.
//
// The rewriting logic lives in `strip-cwd-prefix-core.ts` so it can be
// unit-tested without importing the pi-coding-agent SDK.

const GUIDELINE =
	"Bash commands already run in the session working directory. Never prefix them with `cd <cwd> &&`; use relative paths instead.";

export default function (pi: ExtensionAPI) {
	let stripped = 0;

	// When the ssh extension is active, the session cwd (ctx.cwd) is the local
	// path while commands actually run in a remote directory. Track that remote
	// directory so a redundant `cd <remote> &&` prefix is stripped too.
	let remoteCwd: string | undefined;
	pi.events.on(REMOTE_CWD_CHANNEL, (data) => {
		const event = data as Partial<RemoteCwdEvent> | undefined;
		if (event && typeof event.cwd === "string" && event.cwd !== "") {
			remoteCwd = event.cwd;
		}
	});

	pi.on("before_agent_start", (event) => {
		// Mutate the guideline collection so pi patches only the changed prompt
		// section instead of replacing the whole system prompt. The shared helper
		// keeps the order canonical so the section text is stable across turns.
		addPromptGuideline(event.systemPromptOptions.promptGuidelines, GUIDELINE);
	});

	pi.on("tool_call", (event, ctx) => {
		try {
			if (!isToolCallEventType("bash", event)) return;

			const command = event.input.command;
			const cwds = remoteCwd ? [ctx.cwd, remoteCwd] : ctx.cwd;
			const cleaned = stripRedundantCwdPrefix(command, cwds);
			if (cleaned === null) return;

			event.input.command = cleaned;
			stripped++;
			ctx.ui.setStatus("strip-cwd", `cwd prefix stripped ×${stripped}`);
		} catch (err) {
			console.warn("[strip-cwd-prefix] unexpected error; passing command through", err);
		}
	});
}
