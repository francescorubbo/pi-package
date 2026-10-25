import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import stripCwdPrefix from "../extensions/strip-cwd-prefix.js";
import sshExtension from "../extensions/ssh.js";
import blockExtension from "../extensions/block-shell-commands.js";

type Handler = (event: any, ctx: any) => any;

function createFakePi(flagValue: string) {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, ((data: unknown) => void)[]>();
	const tools = new Map<string, any>();
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerFlag() {},
		getFlag() {
			return flagValue;
		},
		registerCommand() {},
		exec: async () => ({ code: 0 }),
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const list = busHandlers.get(channel) ?? [];
				list.push(handler);
				busHandlers.set(channel, list);
				return () => {};
			},
			emit(channel: string, data: unknown) {
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			},
		},
	};
	return {
		api: api as any,
		tools,
		async emit(event: string, payload: any, ctx: any) {
			for (const handler of handlers.get(event) ?? []) {
				const result = await handler(payload, ctx);
				if (result?.block) return result;
			}
			return undefined;
		},
	};
}

describe("ssh + strip integration", () => {
	it("strips the remote prefix regardless of blocker order", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-ssh-test-"));
		const bin = join(tmp, "bin");
		const project = join(tmp, "project");
		const remote = join(tmp, "remote");
		mkdirSync(bin);
		mkdirSync(project);
		mkdirSync(remote);
		const log = join(tmp, "ssh.log");
		writeFileSync(
			join(bin, "ssh"),
			`#!/bin/sh
if [ "$1" = "-o" ]; then shift 2; fi
host="$1"; shift
printf '%s\\n' "$1" >> "$PI_FAKE_SSH_LOG"
exec /bin/sh -c "$1"
`,
		);
		chmodSync(join(bin, "ssh"), 0o755);
		const oldPath = process.env.PATH;
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const oldLog = process.env.PI_FAKE_SSH_LOG;
		process.env.PATH = `${bin}:${oldPath}`;
		process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
		process.env.PI_FAKE_SSH_LOG = log;
		try {
			for (const order of ["strip-first", "block-first"] as const) {
				const pi = createFakePi(`fake:${remote}`);
				if (order === "strip-first") {
					stripCwdPrefix(pi.api);
					sshExtension(pi.api);
					blockExtension(pi.api);
				} else {
					blockExtension(pi.api);
					stripCwdPrefix(pi.api);
					sshExtension(pi.api);
				}
				const prompts: string[] = [];
				const ctx: any = {
					cwd: project,
					mode: "rpc",
					hasUI: true,
					ui: {
						setStatus() {},
						notify() {},
						addAutocompleteProvider() {},
						async select(prompt: string) {
							prompts.push(prompt);
							return "Allow once";
						},
						theme: { fg: (_c: string, t: string) => t },
					},
				};
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				const event = {
					type: "tool_call",
					toolName: "bash",
					input: { command: `cd ${remote} && echo hello` },
				};
				await pi.emit("tool_call", event, ctx);
				expect(event.input.command).toBe("echo hello");
				expect(prompts).toHaveLength(1);
				expect(prompts[0]).toContain('"echo hello"');
				expect(prompts[0]).not.toContain("cd ");

				// The registered bash tool has the execution-time fallback, too.
				const bash = pi.tools.get("bash");
				const result = await bash.execute(
					"id",
					{ command: `cd ${remote} && echo hello` },
					undefined,
					undefined,
					ctx,
				);
				expect(result.content[0].text.trim()).toBe("hello");
				const lastLogLine = readFileSync(log, "utf8").trim().split("\n").at(-1) ?? "";
				expect(lastLogLine.split("cd ").length - 1).toBe(1);
			}

			// TUI rendering: a local path is displayed as its remote target.
			const pi = createFakePi(`fake:${remote}`);
			sshExtension(pi.api);
			const ctx: any = {
				cwd: project,
				ui: {
					setStatus() {},
					notify() {},
					addAutocompleteProvider() {},
					theme: { fg: (_c: string, t: string) => t },
				},
			};
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			const read = pi.tools.get("read");
			const theme: any = {
				fg: (_c: string, t: string) => t,
				bold: (t: string) => t,
			};
			const localPath = join(dirname(process.cwd()), "elsewhere", "file.txt");
			const mapped = join(dirname(remote), "elsewhere", "file.txt");
			const rendered = read
				.renderCall({ path: localPath }, theme, { cwd: process.cwd(), args: { path: localPath } })
				.render(120)
				.join("\n");
			expect(rendered).toContain(mapped);
			expect(rendered).not.toContain(localPath);
		} finally {
			process.env.PATH = oldPath;
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			if (oldLog === undefined) delete process.env.PI_FAKE_SSH_LOG;
			else process.env.PI_FAKE_SSH_LOG = oldLog;
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
