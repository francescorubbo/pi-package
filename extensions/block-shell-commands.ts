import { ExtensionAPI, ExtensionContext, ToolCallEvent, isToolCallEventType, CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parse } from "shell-quote";

// Commands that are harmless no-ops and should never require approval.
const NOOP_COMMANDS = new Set(["true", ":", "false"]);

// Operators whose following token is a redirection target (file name or file
// descriptor), never an executable.
const REDIRECTION_OPS = new Set([">", ">>", ">&", "<", "<&", "<<<"]);

// Operators that terminate a command; the next word starts a new command.
const COMMAND_SEPARATORS = new Set(["|", "||", "&&", "&", ";", ";;", "|&", "(", "<("]);

type ShellToken = string | { op: string } | { comment: string };

function isComment(token: ShellToken): token is { comment: string } {
    return typeof token === "object" && token !== null && "comment" in token;
}

function isGlob(token: ShellToken): token is { op: "glob"; pattern: string } {
    return typeof token === "object" && token !== null && "op" in token && token.op === "glob";
}

function opOf(token: ShellToken | undefined): string | undefined {
    if (token && typeof token !== "string" && "op" in token) {
        return token.op;
    }
    return undefined;
}

/**
 * Normalizes a shell command before it is tokenized with shell-quote:
 *  - removes heredoc bodies (shell-quote would otherwise tokenize the script
 *    contents as if it were shell input),
 *  - turns top-level newlines into `;` so consecutive lines are recognized as
 *    separate commands,
 *  - strips comments so shell-quote's comment handling cannot swallow the
 *    separators we insert.
 * Quoting and escapes are preserved.
 */
function sanitizeCommand(command: string): string {
    let out = "";
    let i = 0;
    const n = command.length;
    let quote: "'" | '"' | null = null;
    let pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];

    while (i < n) {
        const c = command[i];

        if (quote === "'") {
            out += c;
            if (c === "'") quote = null;
            i++;
            continue;
        }
        if (quote === '"') {
            if (c === "\\") {
                out += c;
                if (i + 1 < n) { out += command[i + 1]; i += 2; } else i++;
                continue;
            }
            out += c;
            if (c === '"') quote = null;
            i++;
            continue;
        }
        if (c === "\\") {
            out += c;
            if (i + 1 < n) { out += command[i + 1]; i += 2; } else i++;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }

        // Heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, ... The body is not shell input.
        if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && (i === 0 || command[i - 1] !== "<")) {
            let j = i + 2;
            let stripTabs = false;
            if (command[j] === "-") { stripTabs = true; j++; }
            while (j < n && (command[j] === " " || command[j] === "\t")) j++;
            let delim = "";
            if (command[j] === '"' || command[j] === "'") {
                const q = command[j];
                j++;
                while (j < n && command[j] !== q) { delim += command[j]; j++; }
                j++;
            } else {
                while (j < n && !/[\s;&|<>()]/.test(command[j])) {
                    if (command[j] === "\\") { j++; if (j < n) { delim += command[j]; j++; } continue; }
                    delim += command[j]; j++;
                }
            }
            // Only treat it as a heredoc when the delimiter looks like a real
            // delimiter; this avoids misreading arithmetic shifts (`$((1<<2))`).
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(delim)) {
                pendingHeredocs.push({ delim, stripTabs });
                i = j;
                continue;
            }
        }

        // Comments run to the end of the line. `#` that is escaped or embedded
        // in a word is kept (escaped) so it is not mistaken for a comment.
        if (c === "#") {
            const prev = i > 0 ? command[i - 1] : "";
            if (prev === "" || /[\s;&|()<>]/.test(prev)) {
                while (i < n && command[i] !== "\n") i++;
                continue;
            }
            out += "\\#";
            i++;
            continue;
        }

        if (c === "\n") {
            out += ";\n";
            i++;
            // Consume the heredoc bodies queued on the line that just ended.
            for (const spec of pendingHeredocs) {
                while (i < n) {
                    const lineEnd = command.indexOf("\n", i);
                    const end = lineEnd === -1 ? n : lineEnd;
                    let line = command.slice(i, end);
                    if (spec.stripTabs) line = line.replace(/^\t+/, "");
                    i = end === n ? n : end + 1;
                    if (line === spec.delim) break;
                }
            }
            pendingHeredocs = [];
            continue;
        }

        out += c;
        i++;
    }

    return out;
}

class BlockShellCommands {
    private projectAllowlist: Set<string> = new Set();
    private globalAllowlist: Set<string> = new Set();
    private projectAllowlistFile: string;
    private globalAllowlistFile: string;

    constructor(cwd: string) {
        const configDir = join(cwd, CONFIG_DIR_NAME);
        this.projectAllowlistFile = join(configDir, "shell-allowlist.json");
        this.globalAllowlistFile = join(getAgentDir(), "shell-allowlist.json");
        this.loadAllowlists();
    }

    private loadAllowlists(): void {
        this.projectAllowlist = this.loadFile(this.projectAllowlistFile);
        this.globalAllowlist = this.loadFile(this.globalAllowlistFile);
    }

    private loadFile(path: string): Set<string> {
        try {
            if (existsSync(path)) {
                const data = readFileSync(path, "utf-8");
                const list = JSON.parse(data);
                return new Set(list);
            }
        } catch (e) {
            console.error(`Failed to load shell allowlist from ${path}:`, e);
        }
        return new Set();
    }

    private saveFile(path: string, list: Set<string>): void {
        try {
            const dir = join(path, "..");
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(path, JSON.stringify(Array.from(list), null, 2));
        } catch (e) {
            console.error(`Failed to save shell allowlist to ${path}:`, e);
        }
    }

    private getCommands(command: string): string[] {
        const sanitized = sanitizeCommand(command);

        let tokens: ShellToken[];
        try {
            tokens = parse(sanitized);
        } catch (e) {
            // Be conservative: if the command cannot be parsed, fall back to a
            // simple split so obvious executables are still checked.
            console.error("Failed to parse shell command for allowlist check:", e);
            return sanitized
                .split(/[;&|\n]+/)
                .map(segment => segment.trim().split(/\s+/)[0])
                .filter((word): word is string => Boolean(word) && !NOOP_COMMANDS.has(word));
        }

        const commands: string[] = [];
        let expectCommand = true;
        let skipRedirectionTarget = false;

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];

            // Comments are never commands.
            if (isComment(token)) continue;

            if (isGlob(token)) {
                if (skipRedirectionTarget) { skipRedirectionTarget = false; continue; }
                if (expectCommand) {
                    if (!NOOP_COMMANDS.has(token.pattern)) commands.push(token.pattern);
                    expectCommand = false;
                }
                continue;
            }

            if (typeof token === "string") {
                if (skipRedirectionTarget) { skipRedirectionTarget = false; continue; }
                if (!expectCommand) continue;

                // `2>` / `2>&1`: a file descriptor, not a command.
                if (/^[0-9]+$/.test(token) && REDIRECTION_OPS.has(opOf(tokens[i + 1]) ?? "")) continue;

                // Leading `VAR=value` assignments do not name the executable.
                if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;

                if (!NOOP_COMMANDS.has(token)) commands.push(token);
                expectCommand = false;
                continue;
            }

            // Control operator.
            const op = token.op;
            if (skipRedirectionTarget) skipRedirectionTarget = false;

            // `<<` / `<<-` heredoc: the delimiter word is not a command.
            if (op === "<" && opOf(tokens[i + 1]) === "<") {
                i++;
                if (i + 1 < tokens.length) i++;
                continue;
            }

            // `>|` (noclobber override) is split by shell-quote into `>` and `|`.
            if (op === ">" && opOf(tokens[i + 1]) === "|") {
                i++;
                skipRedirectionTarget = true;
                continue;
            }

            if (REDIRECTION_OPS.has(op)) { skipRedirectionTarget = true; continue; }
            if (COMMAND_SEPARATORS.has(op)) { expectCommand = true; continue; }
            if (op === ")") { expectCommand = false; continue; }

            // Any other operator (e.g. process substitution) starts a command.
            expectCommand = true;
        }

        return commands;
    }

    public async shouldBlock(command: string, ctx: ExtensionContext): Promise<{ block: boolean; reason?: string }> {
        const commandsToVerify = this.getCommands(command);
        
        for (const cmdToken of commandsToVerify) {
            if (this.projectAllowlist.has(cmdToken) || this.globalAllowlist.has(cmdToken)) {
                continue;
            }

            const response = await ctx.ui.select(
                `Shell command blocked: "${command}"\nUnauthorized executable found: "${cmdToken}"\nAllow once or add to allowlist?`,
                ["Allow once", "Always allow (Project)", "Always allow (Global)", "Block"]
            );

            if (response === "Always allow (Project)") {
                this.projectAllowlist.add(cmdToken);
                this.saveFile(this.projectAllowlistFile, this.projectAllowlist);
            } else if (response === "Always allow (Global)") {
                this.globalAllowlist.add(cmdToken);
                this.saveFile(this.globalAllowlistFile, this.globalAllowlist);
            } else if (response === "Allow once") {
                continue;
            } else {
                return { block: true, reason: `Command "${cmdToken}" blocked by user` };
            }
        }

        return { block: false };
    }

    public add(token: string, global: boolean = false) {
        if (global) {
            this.globalAllowlist.add(token);
            this.saveFile(this.globalAllowlistFile, this.globalAllowlist);
        } else {
            this.projectAllowlist.add(token);
            this.saveFile(this.projectAllowlistFile, this.projectAllowlist);
        }
    }
}

export default function (pi: ExtensionAPI) {
    // Initialize lazily on session_start to get the correct CWD
    let blocker: BlockShellCommands;

    pi.on("session_start", (event, ctx) => {
        blocker = new BlockShellCommands(ctx.cwd);
    });

    pi.on("tool_call", async (event, ctx) => {
        if (isToolCallEventType("bash", event)) {
            const command = (event as any).input.command;
            const result = await blocker.shouldBlock(command, ctx);
            if (result.block) {
                return result as any;
            }
        }
    });

    pi.registerCommand("allow-cmd", {
        description: "Add a command (first token) to the shell allowlist. Use --global for global allowlist.",
        handler: async (args: string, ctx: ExtensionContext) => {
            const parts = args?.trim().split(/\s+/);
            const isGlobal = parts?.includes("--global");
            const token = parts?.filter(p => p !== "--global")[0];

            if (token) {
                blocker.add(token, isGlobal);
                ctx.ui.notify(`Added "${token}" to ${isGlobal ? "global" : "project"} allowlist`, "info");
            } else {
                ctx.ui.notify("Usage: /allow-cmd <command> [--global]", "error");
            }
        },
    });
}
