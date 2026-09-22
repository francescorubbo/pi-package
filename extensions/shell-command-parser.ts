import { parse } from "shell-quote";

// Commands that are harmless no-ops and should never require approval.
export const NOOP_COMMANDS = new Set(["true", ":", "false"]);

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
export function sanitizeCommand(command: string): string {
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

/**
 * Extracts the executables from a shell command string.
 *
 * Redirection targets, heredoc bodies and delimiters, variable assignments,
 * comments and no-op builtins are not reported as commands.
 */
export function extractCommands(command: string): string[] {
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
