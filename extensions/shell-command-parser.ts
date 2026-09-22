import { parse } from "shell-quote";

// Commands that are harmless no-ops and should never require approval.
export const NOOP_COMMANDS = new Set(["true", ":", "false"]);

// Operators whose following token is a redirection target (file name or file
// descriptor), never an executable.
const REDIRECTION_OPS = new Set([">", ">>", ">&", "<", "<&", "<<<", "&>", "<>", ">|", "<<"]);

// Operators that terminate a command; the next word starts a new command.
const COMMAND_SEPARATORS = new Set(["|", "||", "&&", "&", ";", ";;", "|&", "(", "<(", ">("]);

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

/**
 * A word or control operator located at a specific offset in the original
 * command string. Used by the position-aware extractor below so callers can
 * rewrite a command in place.
 */
export interface PositionedWord {
    kind: "word";
    /** Dequoted value of the word. */
    value: string;
    /** Offset of the first character of the token in the original string. */
    start: number;
    /** Offset just past the last character of the token. */
    end: number;
}

export interface PositionedOperator {
    kind: "op";
    value: string;
    start: number;
    end: number;
}

export type PositionedToken = PositionedWord | PositionedOperator;

// Characters that end an unquoted word (shell metacharacters and whitespace).
const WORD_TERMINATORS = new Set([" ", "\t", "\r", "\n", ";", "|", "&", "<", ">", "(", ")"]);

const TWO_CHAR_OPERATORS = new Set([
    "&&", "||", "|&", ">>", ">&", "<>", "&>", ">|", "<&", ";;", "<(", ">(",
]);

/**
 * Tokenizes a command string while keeping source offsets, understanding
 * quoting, escapes, comments and heredocs. Unlike shell-quote it does not
 * expand variables or globs: it returns the literal, dequoted word text.
 *
 * Heredoc bodies are skipped (they are data, not shell input). Command
 * substitution (`$(...)`) and backticks are consumed as an opaque part of the
 * enclosing word.
 */
export function tokenizeCommand(command: string): PositionedToken[] {
    const tokens: PositionedToken[] = [];
    const n = command.length;
    let i = 0;
    let pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];

    const consumeHeredocBodies = () => {
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
    };

    while (i < n) {
        const c = command[i];

        if (c === " " || c === "\t" || c === "\r") {
            i++;
            continue;
        }

        // A newline separates commands; consume any queued heredoc bodies.
        if (c === "\n") {
            tokens.push({ kind: "op", value: ";", start: i, end: i + 1 });
            i++;
            consumeHeredocBodies();
            continue;
        }

        // Comments run to the end of the line.
        if (c === "#") {
            while (i < n && command[i] !== "\n") i++;
            continue;
        }

        if (command.startsWith("<<<", i)) {
            tokens.push({ kind: "op", value: "<<<", start: i, end: i + 3 });
            i += 3;
            continue;
        }

        // Heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, ...
        if (command.startsWith("<<", i)) {
            let j = i + 2;
            let stripTabs = false;
            if (command[j] === "-") {
                stripTabs = true;
                j++;
            }
            while (j < n && (command[j] === " " || command[j] === "\t")) j++;
            let delim = "";
            if (command[j] === '"' || command[j] === "'") {
                const q = command[j];
                j++;
                while (j < n && command[j] !== q) {
                    delim += command[j];
                    j++;
                }
                j++;
            } else {
                while (j < n && !/[\s;&|<>()]/.test(command[j])) {
                    if (command[j] === "\\") {
                        j++;
                        if (j < n) {
                            delim += command[j];
                            j++;
                        }
                        continue;
                    }
                    delim += command[j];
                    j++;
                }
            }
            tokens.push({ kind: "op", value: "<<", start: i, end: i + 2 });
            // Only a plausible delimiter is a real heredoc; this avoids
            // misreading arithmetic shifts (`$((1<<2))`).
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(delim)) {
                pendingHeredocs.push({ delim, stripTabs });
            }
            i = j;
            continue;
        }

        const two = command.slice(i, i + 2);
        if (TWO_CHAR_OPERATORS.has(two)) {
            tokens.push({ kind: "op", value: two, start: i, end: i + 2 });
            i += 2;
            continue;
        }

        if (";|&<>()".includes(c)) {
            tokens.push({ kind: "op", value: c, start: i, end: i + 1 });
            i++;
            continue;
        }

        // A word: consume until an unquoted metacharacter.
        const start = i;
        let value = "";
        while (i < n) {
            const ch = command[i];
            if (WORD_TERMINATORS.has(ch)) break;

            if (ch === "\\") {
                if (i + 1 < n) {
                    value += command[i + 1];
                    i += 2;
                } else {
                    i++;
                }
                continue;
            }

            if (ch === "'") {
                i++;
                while (i < n && command[i] !== "'") {
                    value += command[i];
                    i++;
                }
                if (i < n) i++;
                continue;
            }

            if (ch === '"') {
                i++;
                while (i < n && command[i] !== '"') {
                    if (command[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(command[i + 1])) {
                        if (command[i + 1] === "\n") {
                            i += 2;
                            continue;
                        }
                        value += command[i + 1];
                        i += 2;
                        continue;
                    }
                    value += command[i];
                    i++;
                }
                if (i < n) i++;
                continue;
            }

            if (ch === "$" && command[i + 1] === "(") {
                // Opaque command substitution: consume its balanced parentheses.
                let depth = 0;
                const subStart = i;
                i++;
                do {
                    if (command[i] === "(") depth++;
                    else if (command[i] === ")") depth--;
                    i++;
                } while (i < n && depth > 0);
                value += command.slice(subStart, i);
                continue;
            }

            if (ch === "`") {
                i++;
                while (i < n && command[i] !== "`") {
                    if (command[i] === "\\" && i + 1 < n) {
                        value += command[i + 1];
                        i += 2;
                        continue;
                    }
                    value += command[i];
                    i++;
                }
                if (i < n) i++;
                continue;
            }

            value += ch;
            i++;
        }

        tokens.push({ kind: "word", value, start, end: i });
    }

    return tokens;
}

/**
 * Like {@link extractCommands}, but returns the executable together with its
 * source offsets so a caller can rewrite the command in place.
 */
export interface CommandInvocation {
    /** Dequoted executable as written, e.g. `.venv/bin/python` or `python3`. */
    command: string;
    /** Offset of the executable token in the original string. */
    start: number;
    /** Offset just past the executable token. */
    end: number;
}

export function extractCommandsWithPositions(command: string): CommandInvocation[] {
    const tokens = tokenizeCommand(command);
    const commands: CommandInvocation[] = [];
    let expectCommand = true;
    let skipRedirectionTarget = false;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token.kind === "word") {
            if (skipRedirectionTarget) {
                skipRedirectionTarget = false;
                continue;
            }
            if (!expectCommand) continue;

            // `2>` / `2>&1`: a file descriptor, not a command.
            const next = tokens[i + 1];
            if (/^[0-9]+$/.test(token.value) && next?.kind === "op" && REDIRECTION_OPS.has(next.value)) {
                continue;
            }

            // Leading `VAR=value` assignments do not name the executable.
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) continue;

            if (!NOOP_COMMANDS.has(token.value)) {
                commands.push({ command: token.value, start: token.start, end: token.end });
            }
            expectCommand = false;
            continue;
        }

        const op = token.value;
        if (skipRedirectionTarget) skipRedirectionTarget = false;

        // Heredoc: the delimiter was already consumed by the tokenizer.
        if (op === "<<") continue;

        if (REDIRECTION_OPS.has(op)) {
            skipRedirectionTarget = true;
            continue;
        }
        if (COMMAND_SEPARATORS.has(op)) {
            expectCommand = true;
            continue;
        }
        if (op === ")") {
            expectCommand = false;
            continue;
        }

        // Any other operator (e.g. process substitution) starts a command.
        expectCommand = true;
    }

    return commands;
}

/** Returns the dequoted word tokens (operators excluded) with offsets. */
export function extractWordTokens(command: string): PositionedWord[] {
    return tokenizeCommand(command).filter((t): t is PositionedWord => t.kind === "word");
}
