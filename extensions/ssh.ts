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
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { REMOTE_CWD_CHANNEL } from "./remote-cwd.js";
import { addPromptGuideline } from "./prompt-guidelines.js";
import { prependRemotePath } from "./ssh-remote-env.js";

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

/** Resolve the `--ssh` flag into a remote target and an absolute remote cwd. */
async function resolveSshTarget(arg: string): Promise<{ remote: string; remoteCwd: string }> {
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
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
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
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	let autocompleteRegistered = false;

	const getSsh = () => resolvedSsh;

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
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createReadTool(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createWriteTool(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createEditTool(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
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
