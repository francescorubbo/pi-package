import { resolve } from "node:path";
import { tokenizeCommand } from "./shell-command-parser.js";

// Pure command-rewriting logic for the strip-cwd-prefix extension. Kept free
// of any pi-coding-agent imports so it can be unit-tested without loading the
// SDK.

/** Shell expansions that always refer to the current working directory. */
const CWD_ALIASES = new Set(["$PWD", "${PWD}"]);

/** Separators that let us drop a no-op leading `cd` without changing behavior. */
const SAFE_SEPARATORS = new Set(["&&", ";"]);

/**
 * Normalizes the caller-supplied working directory (or directories) into a
 * non-empty list. Accepts several candidates because a session can have more
 * than one valid "here": e.g. the local cwd plus the remote cwd when the bash
 * tool runs over SSH.
 */
function normalizeCwds(cwd: string | readonly string[]): string[] {
	return (typeof cwd === "string" ? [cwd] : [...cwd]).filter((c) => c.length > 0);
}

/** Returns true when `target` is a no-op `cd` back into one of `cwds`. */
function isCwdTarget(target: string, cwds: readonly string[]): boolean {
	// `cd ""` is an error in bash, not a jump to cwd.
	if (target === "" || target === "-") return false;
	if (CWD_ALIASES.has(target)) return true;
	// Lexical comparison only: a symlinked path that resolves elsewhere is
	// left untouched (conservative).
	return cwds.some((cwd) => resolve(cwd, target) === resolve(cwd));
}

/**
 * Removes a leading `cd <cwd>` prefix from a shell command. Only strips the
 * prefix when every leading `cd` is a no-op (its target resolves back to one
 * of the supplied working directories) and a real command follows it. Returns
 * the rewritten command, or `null` when nothing changed.
 *
 * `cwd` may be a single directory or a list of valid directories. The list
 * form is used in SSH sessions, where the session cwd is the local path but
 * the command actually runs in a different remote directory.
 *
 * Examples (cwd = `/home/me/proj`):
 *   `cd /home/me/proj && ls`  -> `ls`
 *   `cd "$PWD" && ls`         -> `ls`
 *   `cd /home/me/proj; ls`    -> `ls`
 *   `cd /home/me/proj &&`     -> null   (nothing left to run)
 *   `cd /elsewhere && ls`     -> null   (intentional cd)
 *   `ls && cd /home/me/proj`  -> null   (not a prefix)
 */
export function stripRedundantCwdPrefix(
	command: string,
	cwd: string | readonly string[],
): string | null {
	if (typeof command !== "string" || command.trim() === "") return null;

	const cwds = normalizeCwds(cwd);
	if (cwds.length === 0) return null;

	const tokens = tokenizeCommand(command);
	let index = 0;
	let cut = 0;
	let stripped = 0;

	while (true) {
		const cd = tokens[index];
		if (!cd || cd.kind !== "word" || cd.value !== "cd") break;

		// Optional `--` end-of-options marker: `cd -- /dir`.
		let argIndex = index + 1;
		if (tokens[argIndex]?.kind === "word" && tokens[argIndex].value === "--") {
			argIndex++;
		}

		const target = tokens[argIndex];
		if (!target || target.kind !== "word") break;
		if (!isCwdTarget(target.value, cwds)) break;

		const separator = tokens[argIndex + 1];
		if (!separator || separator.kind !== "op" || !SAFE_SEPARATORS.has(separator.value)) break;

		// Leave `cd <cwd>` alone when it is the entire command: slicing it out
		// would leave an empty command instead of a harmless no-op.
		if (!tokens[argIndex + 2]) break;

		cut = separator.end;
		stripped++;
		index = argIndex + 2;
	}

	if (stripped === 0) return null;
	return command.slice(cut).replace(/^\s+/, "");
}
