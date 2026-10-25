/**
 * SSH Remote Execution
 *
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { REMOTE_CWD_CHANNEL } from "./remote-cwd.js";
import { REMOTE_FS_CHANNEL, type RemoteFileSystem } from "./remote-fs.js";
import { addPromptGuideline } from "./prompt-guidelines.js";
import { prependRemotePath } from "./ssh-remote-env.js";
import { stripRedundantCwdPrefix } from "./strip-cwd-prefix-core.js";

type SshTarget = { remote: string; remoteCwd: string };

function sshSpawn(remote: string, args: string[], options?: { input?: Buffer }) {
	// Non-interactive SSH does not source the user's profile, so user-local
	// tools such as `uv` (~/.local/bin/uv) are not on the remote PATH. Apply
	// the PATH prefix centrally here so every remote operation (bash, read,
	// write, edit, autocomplete) sees them without callers prefixing commands.
	const remoteArgs = args.length === 1 ? [prependRemotePath(args[0])] : args;
	const child = spawn("ssh", ["-o", "BatchMode=yes", remote, ...remoteArgs], {
		stdio: [options?.input ? "pipe" : "ignore", "pipe", "pipe"],
	});
	if (options?.input && child.stdin) {
		child.stdin.write(options.input);
		child.stdin.end();
	}
	return child;
}

function sshExec(remote: string, command: string, input?: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = sshSpawn(remote, [command], { input });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout?.on("data", (data) => chunks.push(data));
		child.stderr?.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

/** Async filesystem probe backed by `sshExec`, for remote `uv.lock` detection. */
function createRemoteFileSystem(remote: string): RemoteFileSystem {
	return {
		exists: (path) =>
			sshExec(remote, `test -e ${JSON.stringify(path)}`).then(
				() => true,
				() => false,
			),
		readdir: (path) =>
			sshExec(remote, `ls -1 ${JSON.stringify(path)}`).then(
				(out) => out.toString().split("\n").filter(Boolean),
				() => [],
			),
	};
}

/** Resolve the `--ssh` flag into a remote target and an absolute remote cwd. */
async function resolveSshTarget(arg: string): Promise<SshTarget> {
	const colon = arg.indexOf(":");
	if (colon !== -1) {
		const remote = arg.slice(0, colon);
		const remotePath = arg.slice(colon + 1);
		// Resolve to an absolute path on the remote so path mapping is stable.
		const command = remotePath ? `cd ${JSON.stringify(remotePath)} && pwd` : "pwd";
		const remoteCwd = (await sshExec(remote, command)).toString().trim();
		return { remote, remoteCwd };
	}
	const remote = arg;
	const remoteCwd = (await sshExec(remote, "pwd")).toString().trim();
	return { remote, remoteCwd };
}

/** Arguments that hold a file path in the built-in file tools. */
const DISPLAY_PATH_KEYS = ["path", "file_path"] as const;

/**
 * Maps the path-like arguments of a tool call into the remote tree for display.
 * The tools themselves already do this before executing; this keeps the TUI
 * transcript (and its hyperlinks) showing the remote target too.
 */
function mapDisplayArgs(args: unknown, toRemote: (p: string) => string): unknown {
	if (!args || typeof args !== "object") return args;
	const record = args as Record<string, unknown>;
	let changed = false;
	const mapped: Record<string, unknown> = { ...record };
	for (const key of DISPLAY_PATH_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) {
			const remote = toRemote(value);
			if (remote !== value) {
				mapped[key] = remote;
				changed = true;
			}
		}
	}
	return changed ? mapped : args;
}

/**
 * Wraps a tool's renderers so the TUI uses the remote cwd and remote paths
 * while an SSH session is active. Renderers receive the session cwd (the
 * local directory) from pi, which would otherwise make remote files appear
 * as local ones in the transcript.
 */
function withRemotePathDisplay<T extends { renderCall?: any; renderResult?: any }>(
	tool: T,
	getSsh: () => SshTarget | null,
	localCwd: string,
): T {
	const { renderCall, renderResult } = tool;
	if (!renderCall && !renderResult) return tool;

	const remap = (args: unknown, context: any, ssh: SshTarget) => {
		const mappedArgs = mapDisplayArgs(args, createRemotePathMapper(ssh.remoteCwd, localCwd));
		return { args: mappedArgs, context: { ...context, cwd: ssh.remoteCwd, args: mappedArgs } };
	};

	return {
		...tool,
		...(renderCall
			? {
					renderCall: (args: unknown, theme: any, context: any) => {
						const ssh = getSsh();
						if (!ssh) return renderCall(args, theme, context);
						const display = remap(args, context, ssh);
						return renderCall(display.args, theme, display.context);
					},
				}
			: {}),
		...(renderResult
			? {
					renderResult: (result: unknown, options: any, theme: any, context: any) => {
						const ssh = getSsh();
						if (!ssh) return renderResult(result, options, theme, context);
						const display = remap(context.args, context, ssh);
						return renderResult(result, options, theme, display.context);
					},
				}
			: {}),
	} as T;
}

function createRemotePathMapper(remoteCwd: string, localCwd: string) {
	const localPrefix = localCwd.endsWith(path.sep) ? localCwd : `${localCwd}${path.sep}`;
	const remotePrefix = remoteCwd.endsWith("/") ? remoteCwd : `${remoteCwd}/`;
	const toRemotePosix = (local: string) =>
		path.posix.join(remoteCwd, path.relative(localCwd, local).split(path.sep).join("/"));
	return (p: string) => {
		const abs = path.resolve(localCwd, p);
		// A local path (relative or absolute) is mapped into the remote tree.
		if (abs === localCwd || abs.startsWith(localPrefix)) return toRemotePosix(abs);
		// A path that is already absolute on the remote host (e.g. one the model
		// copied from the system prompt's `<cwd>` section) is returned as-is, so
		// making the prompt advertise the remote cwd does not break file tools.
		if (p === remoteCwd || p.startsWith(remotePrefix)) return p;
		// Unknown absolute path: best-effort map relative to the local root.
		return toRemotePosix(p);
	};
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = createRemotePathMapper(remoteCwd, localCwd);
	return {
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = createRemotePathMapper(remoteCwd, localCwd);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `base64 -d > ${JSON.stringify(toRemote(p))}`, Buffer.from(b64));
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = createRemotePathMapper(remoteCwd, localCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const remoteTarget = toRemote(cwd);
				// The strip-cwd-prefix extension normally removes this before the call
				// reaches us, but do it here as well: the command that actually runs on
				// the remote must never depend on extension load order or on whether that
				// extension is installed at all.
				const cleaned =
					stripRedundantCwdPrefix(command, [remoteTarget, remoteCwd, localCwd]) ?? command;
				const cmd = `cd ${JSON.stringify(remoteTarget)} && ${cleaned}`;
				const child = sshSpawn(remote, [cmd]);
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	const localRead = createReadToolDefinition(localCwd);
	const localWrite = createWriteToolDefinition(localCwd);
	const localEdit = createEditToolDefinition(localCwd);
	const localBash = createBashToolDefinition(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: SshTarget | null = null;
	let autocompleteRegistered = false;

	const getSsh = () => resolvedSsh;

	// The registered definitions carry the renderers, so wrap them once here.
	// Every renderer consults getSsh(), which is populated on session_start.
	const displayRead = withRemotePathDisplay(localRead, getSsh, localCwd);
	const displayWrite = withRemotePathDisplay(localWrite, getSsh, localCwd);
	const displayEdit = withRemotePathDisplay(localEdit, getSsh, localCwd);
	const displayBash = withRemotePathDisplay(localBash, getSsh, localCwd);

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			try {
				resolvedSsh = await resolveSshTarget(arg);
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
				// Publish the remote cwd so strip-cwd-prefix can recognize redundant
				// `cd <remote> &&` prefixes in bash commands.
				pi.events.emit(REMOTE_CWD_CHANNEL, { cwd: resolvedSsh.remoteCwd, remote: resolvedSsh.remote });
				// Publish a remote filesystem probe so pi-uv detects `uv.lock` on the
				// host the command actually runs on, not the local machine.
				pi.events.emit(REMOTE_FS_CHANNEL, {
					cwd: resolvedSsh.remoteCwd,
					remote: resolvedSsh.remote,
					fs: createRemoteFileSystem(resolvedSsh.remote),
				});
			} catch (err: any) {
				ctx.ui.notify(`SSH connection/setup failed: ${err.message}`, "error");
			}
		}

		if (autocompleteRegistered) return;
		autocompleteRegistered = true;

		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const ssh = getSsh();
				if (!ssh) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);

				const match = beforeCursor.match(/@([^\s]*)$/);
				if (!match) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const query = match[1] ?? "";
				const remoteDir = path.posix.join(ssh.remoteCwd, path.dirname(query));

				try {
					const cmd = `find ${JSON.stringify(remoteDir)} -maxdepth 2 -not -path '*/.*' 2>/dev/null`;
					const res = await sshExec(ssh.remote, cmd);
					const files = res.toString().trim().split("\n").filter(Boolean);

					const items = files.map((filePath) => {
						const rel = path.posix.relative(ssh.remoteCwd, filePath);
						return {
							value: `@${rel}`,
							label: rel,
							description: `remote: ${ssh.remote}`,
						};
					});

					return {
						items,
						prefix: `@${query}`,
					};
				} catch {
					return null;
				}
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const ssh = getSsh();
				if (!ssh) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				}
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol - prefix.length);
				const after = line.slice(cursorCol);
				const newLines = [...lines];
				newLines[cursorLine] = `${before}${item.value} ${after}`;
				return {
					lines: newLines,
					cursorLine,
					cursorCol: before.length + item.value.length + 1,
				};
			},
		}));
	});

	pi.registerTool({
		...displayRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createReadToolDefinition(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate, _ctx);
			}
			return localRead.execute(id, params, signal, onUpdate, _ctx);
		},
	});

	pi.registerTool({
		...displayWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createWriteToolDefinition(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate, _ctx);
			}
			return localWrite.execute(id, params, signal, onUpdate, _ctx);
		},
	});

	pi.registerTool({
		...displayEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createEditToolDefinition(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate, _ctx);
			}
			return localEdit.execute(id, params, signal, onUpdate, _ctx);
		},
	});

	pi.registerTool({
		...displayBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createBashToolDefinition(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate, undefined as any);
			}
			return localBash.execute(id, params, signal, onUpdate, undefined as any);
		},
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	// Advertise the remote cwd instead of the local one, and tell the model that
	// bash already starts there.
	//
	// This mutates the structured `systemPromptOptions` rather than returning a
	// `systemPrompt`. Returning a whole prompt sets `forceSystemPrompt`, which
	// would discard other extensions' `promptGuidelines` additions (e.g. the
	// strip-cwd-prefix and pi-uv guidelines) from the request actually sent.
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (!ssh) return;

		event.systemPromptOptions.cwd = ssh.remoteCwd;
		const guideline = `File and bash tools run on the remote host ${ssh.remote} over SSH. Bash commands already start in the remote project root (${ssh.remoteCwd}), so never prefix them with \`cd\`; use project-relative paths instead.`;
		// The shared helper keeps the guideline order canonical, so the rendered
		// `<rules>` section stays byte-identical across turns (and therefore avoids
		// re-patching it as a cache miss).
		addPromptGuideline(event.systemPromptOptions.promptGuidelines, guideline);
	});
}
