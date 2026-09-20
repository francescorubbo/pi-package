import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

// pi extension — auto-rewrites Python commands to use `uv run`.
// Requires: uv in PATH.
//
// Detects Python-related commands (python, pytest, ruff, etc.) and
// prepends `uv run --project <project>` so they execute inside the
// correct uv-managed virtual environment.
//
// Project root detection (in order):
//   1. From command argument path (e.g. project-a/main.py → project-a/)
//   2. Walk up from CWD looking for uv.lock
//   3. Scan CWD's immediate subdirectories for uv.lock

const REWRITE_TIMEOUT_MS = 2_000;

const PYTHON_TOOLS = [
	"python",
	"python3",
	"pytest",
	"coverage",
	"tox",
	"ruff",
	"mypy",
	"black",
	"isort",
	"flake8",
	"pylint",
	"pyright",
	"pyproject-fmt",
	"pip",
	"pip3",
	"twine",
	"uvicorn",
	"gunicorn",
	"fastapi",
	"django-admin",
];

// Build a regex that matches any tool name at the start of a command,
// using a word boundary to avoid matching longer names by accident.
const TOOL_PATTERN = new RegExp(`^\\s*(?:${PYTHON_TOOLS.join("|")})\\b`);

const BLOCK_TOKENS = ["uv run", "uvx"];

// Split by shell operators, keeping the operators in the result
const SHELL_OP_RE = /(\\s*&&\\s*|\\s*\\|\\|\\s*|\\s*\\|\\s*|\\s*;\\s*|\\s*<\\s*|\\s*>\\s*)/;

/**
 * Extract the first non-flag positional argument that contains a path
 * separator. Skips the tool name, flags (-m, -c, etc.), and their values.
 *
 * @returns The raw argument string (e.g. "project-a/main.py"), or null.
 */
function extractTargetPath(tokens: string[]): string | null {
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];

		// Skip -m <module> and -c <code>
		if (token === "-m" || token === "-c") {
			i++; // consume the module-name / inline-code argument
			continue;
		}

		// Skip other flags
		if (token.startsWith("-")) continue;

		// First positional argument — if it contains '/' treat it as a path
		if (token.includes("/")) return token;

		// Otherwise stop — the first non-path positional arg isn't a target path
		break;
	}
	return null;
}

/**
 * Walk up from `dir` toward the filesystem root looking for a `uv.lock` file.
 *
 * @returns The absolute path of the directory containing `uv.lock`, or null.
 */
function walkUpForLock(dir: string): string | null {
	let current = resolve(dir);
	while (true) {
		if (existsSync(join(current, "uv.lock"))) return current;
		const parent = dirname(current);
		if (parent === current) break; // hit filesystem root
		current = parent;
	}
	return null;
}

/**
 * Detect the uv project root from the command and current working directory.
 *
 * Strategy (in order):
 *   Phase 1 — Extract a file/directory path from the command's arguments.
 *             Resolve it relative to CWD and walk up looking for `uv.lock`.
 *   Phase 2 — Walk up from CWD itself.
 *   Phase 3 — Scan CWD's immediate subdirectories for `uv.lock`.
 *
 * @returns Absolute path to the project root, or null if none found.
 */
function findUvProjectRoot(cwd: string, cmd: string): string | null {
	const tokens = cmd.trim().split(/\\s+/);

	// Phase 1: command argument path
	const argPath = extractTargetPath(tokens);
	if (argPath) {
		const absPath = resolve(cwd, argPath);
		const dir = dirname(absPath);
		const found = walkUpForLock(dir);
		if (found) return found;
	}

	// Phase 2: walk up from CWD
	const found = walkUpForLock(cwd);
	if (found) return found;

	// Phase 3: scan CWD's immediate subdirectories
	try {
		for (const entry of readdirSync(cwd)) {
			const full = join(cwd, entry);
			if (existsSync(join(full, "uv.lock"))) return full;
		}
	} catch {
		// CWD is not readable — silently skip Phase 3
	}

	return null;
}

function quotePath(p: string): string {
	return /[\\s'\"]/.test(p) ? `"${p}"` : p;
}

function rewriteCommand(cmd: string, cwd: string): string | null {
	const parts = cmd.split(SHELL_OP_RE);
	let changed = false;

	for (let i = 0; i < parts.length; i++) {
		const segment = parts[i].trim();

		// Skip shell operators (odd indices) and empty segments
		if (i % 2 === 1 || !segment) continue;

		if (!TOOL_PATTERN.test(segment)) continue;

		// Check if already wrapped
		let alreadyWrapped = false;
		for (const token of BLOCK_TOKENS) {
			if (segment.includes(token)) {
				alreadyWrapped = true;
				break;
			}
		}
		if (alreadyWrapped) continue;

		// Detect project root
		const projectRoot = findUvProjectRoot(cwd, segment);
		if (!projectRoot) continue;

		const relPath = relative(cwd, projectRoot) || ".";
		parts[i] = `uv run --project ${quotePath(relPath)} ${segment}`;
		changed = true;
	}

	if (!changed) return null;
	return parts.join("");
}

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