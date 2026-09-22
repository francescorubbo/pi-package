import { existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { extractCommandsWithPositions, extractWordTokens } from "./shell-command-parser.js";

// Pure command-rewriting logic for the pi-uv extension. Kept free of any
// pi-coding-agent imports so it can be unit-tested without loading the SDK.

/**
 * Filesystem probe used for `uv.lock` project detection. Async so the ssh
 * extension can supply a remote-host implementation; the default reads the
 * local filesystem.
 */
export interface ProjectFileSystem {
	/** True when `path` exists. */
	exists(path: string): Promise<boolean>;
	/** Immediate child names of directory `path`, or `[]` when unreadable. */
	readdir(path: string): Promise<string[]>;
}

/** Probe over the local filesystem; used when no remote probe is available. */
const localFileSystem: ProjectFileSystem = {
	exists: async (path) => existsSync(path),
	readdir: async (path) => {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
};

const PYTHON_TOOLS = new Set([
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
	"ty",
	"pip",
	"pip3",
	"twine",
	"uvicorn",
	"gunicorn",
	"fastapi",
	"django-admin",
]);

// Versioned interpreters such as `python3.12` or `python2.7`.
const VERSIONED_PYTHON_RE = /^python\d+(?:\.\d+)*$/;

/** Returns the last path segment, e.g. `.venv/bin/python` → `python`. */
function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
}

function isPythonTool(name: string): boolean {
	return PYTHON_TOOLS.has(name) || VERSIONED_PYTHON_RE.test(name);
}

/**
 * Extract the first non-flag positional argument that contains a path
 * separator from a command's argument words. Skips flags (-m, -c, etc.)
 * and their values.
 *
 * @param args Argument words, excluding the executable itself.
 * @returns The raw argument string (e.g. "project-a/main.py"), or null.
 */
function extractTargetPath(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const token = args[i];

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
async function walkUpForLock(dir: string, fs: ProjectFileSystem): Promise<string | null> {
	let current = resolve(dir);
	while (true) {
		if (await fs.exists(join(current, "uv.lock"))) return current;
		const parent = dirname(current);
		if (parent === current) break; // hit filesystem root
		current = parent;
	}
	return null;
}

async function findUvProjectRoot(
	cwd: string,
	argPath: string | null,
	fs: ProjectFileSystem,
): Promise<string | null> {
	// Phase 1: command argument path
	if (argPath) {
		const absPath = resolve(cwd, argPath);
		const found = await walkUpForLock(dirname(absPath), fs);
		if (found) return found;
	}

	// Phase 2: walk up from CWD
	const found = await walkUpForLock(cwd, fs);
	if (found) return found;

	// Phase 3: scan CWD's immediate subdirectories
	for (const entry of await fs.readdir(cwd)) {
		const full = join(cwd, entry);
		if (await fs.exists(join(full, "uv.lock"))) return full;
	}

	return null;
}

function quotePath(p: string): string {
	return /[\s'"]/.test(p) ? `"${p}"` : p;
}

/**
 * Rewrite every Python-tool invocation in `cmd` to run through `uv run`,
 * inserting the wrapper at the executable's position. Replacements are
 * applied right-to-left so earlier source offsets stay valid.
 *
 * Project detection runs against `fs`, so callers can pass a probe for the
 * machine the command will actually execute on (e.g. the remote host in SSH
 * sessions). `cwd` must be the directory the command runs in on that machine.
 *
 * @returns The rewritten command, or null when nothing was changed.
 */
export async function rewriteCommand(
	cmd: string,
	cwd: string,
	fs: ProjectFileSystem = localFileSystem,
): Promise<string | null> {
	const commands = extractCommandsWithPositions(cmd);
	if (commands.length === 0) return null;

	// Word tokens are only needed to locate each invocation's target path.
	const words = extractWordTokens(cmd);

	let result = cmd;
	let changed = false;

	for (let idx = commands.length - 1; idx >= 0; idx--) {
		const invocation = commands[idx];
		const tool = basename(invocation.command);
		if (!isPythonTool(tool)) continue;

		// This invocation's arguments end where the next command begins.
		const nextStart = commands[idx + 1]?.start ?? cmd.length;
		const args = words
			.filter((w) => w.start >= invocation.end && w.start < nextStart)
			.map((w) => w.value);

		const projectRoot = await findUvProjectRoot(cwd, extractTargetPath(args), fs);
		if (!projectRoot) continue;

		const relPath = relative(cwd, projectRoot) || ".";
		const replacement = `uv run --project ${quotePath(relPath)} ${tool}`;
		result = result.slice(0, invocation.start) + replacement + result.slice(invocation.end);
		changed = true;
	}

	return changed ? result : null;
}
