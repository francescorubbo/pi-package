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

function sshSpawn(remote: string, args: string[], options?: { input?: Buffer }) {
	const child = spawn("ssh", ["-o", "BatchMode=yes", remote, ...args], {
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

function createRemotePathMapper(remoteCwd: string, localCwd: string) {
	return (p: string) => {
		const rel = path.relative(localCwd, p);
		return path.posix.join(remoteCwd, rel.split(path.sep).join("/"));
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

	const getSsh = () => resolvedSsh;

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			try {
				if (arg.includes(":")) {
					const [remote, remotePath] = arg.split(":");
					resolvedSsh = { remote, remoteCwd: remotePath };
				} else {
					const remote = arg;
					const pwd = (await sshExec(remote, "pwd")).toString().trim();
					resolvedSsh = { remote, remoteCwd: pwd };
				}
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
			} catch (err: any) {
				ctx.ui.notify(`SSH connection/setup failed: ${err.message}`, "error");
			}
		}

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

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			try {
				if (arg.includes(":")) {
					const [remote, remotePath] = arg.split(":");
					resolvedSsh = { remote, remoteCwd: remotePath };
				} else {
					const remote = arg;
					const pwd = (await sshExec(remote, "pwd")).toString().trim();
					resolvedSsh = { remote, remoteCwd: pwd };
				}
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
			} catch (err: any) {
				ctx.ui.notify(`SSH connection/setup failed: ${err.message}`, "error");
			}
		}
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
