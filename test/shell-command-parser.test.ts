import { describe, expect, it } from "vitest";
import { extractCommands, sanitizeCommand } from "../extensions/shell-command-parser.js";

describe("extractCommands", () => {
    describe("simple commands", () => {
        it.each([
            ["echo hello", ["echo"]],
            ["uv run pytest", ["uv"]],
            ["git status", ["git"]],
            ["  ls  ", ["ls"]],
            ["", []],
            ["   ", []],
        ])("parses %j", (command, expected) => {
            expect(extractCommands(command)).toEqual(expected);
        });
    });

    describe("output redirection", () => {
        it.each([
            ["foo 2>/dev/null", ["foo"]],
            ["foo 2>&1", ["foo"]],
            ["foo > out.txt", ["foo"]],
            ["foo >> out.txt 2>&1", ["foo"]],
            ["foo < in.txt", ["foo"]],
            ["2>/dev/null", []],
            ["2>&1", []],
            ["2>$1", []],
            ["cmd > file # comment", ["cmd"]],
            ["cmd > *.txt", ["cmd"]],
            ["cmd 2>&1 | tee log", ["cmd", "tee"]],
            ["cmd 2>>log", ["cmd"]],
            ["cmd &>log", ["cmd"]],
            ["cmd >|log", ["cmd"]],
            ["cmd <>file", ["cmd"]],
            ["cmd <&0", ["cmd"]],
            ["cmd 0<&-", ["cmd"]],
            ["python3 <<< \"data\"", ["python3"]],
        ])("parses %j", (command, expected) => {
            expect(extractCommands(command)).toEqual(expected);
        });
    });

    describe("heredocs", () => {
        it("does not treat the delimiter or body as commands", () => {
            const command = [
                "python3 - <<'PY'",
                "import os",
                "print(os.getcwd())",
                "PY",
            ].join("\n");
            expect(extractCommands(command)).toEqual(["python3"]);
        });

        it("still finds commands after a heredoc", () => {
            const command = ["python3 - <<'PY'", "print(1)", "PY", "printf done"].join("\n");
            expect(extractCommands(command)).toEqual(["python3", "printf"]);
        });

        it.each([
            ["cat <<EOF\nhello world\nEOF", ["cat"]],
            ["cat <<-EOF\n\thello\n\tEOF", ["cat"]],
            ["cat <<A <<B\nbodyA\nA\nbodyB\nB\ncmd", ["cat", "cmd"]],
            ["cmd <<EOF\nEOF\ncmd2", ["cmd", "cmd2"]],
        ])("parses %j", (command, expected) => {
            expect(extractCommands(command)).toEqual(expected);
        });

        it("ignores a heredoc nested in a multiline shell script", () => {
            const command = [
                "cd /tmp && python3 - <<'PY'",
                "print('a')",
                "PY",
                "grep foo file.txt",
            ].join("\n");
            expect(extractCommands(command)).toEqual(["cd", "python3", "grep"]);
        });
    });

    describe("separators and no-op builtins", () => {
        it.each([
            ["foo || true", ["foo"]],
            ["foo && true", ["foo"]],
            ["foo || :", ["foo"]],
            ["true", []],
            ["foo | grep bar", ["foo", "grep"]],
            ["cmd1 & cmd2", ["cmd1", "cmd2"]],
            ["cmd1; cmd2", ["cmd1", "cmd2"]],
            ["echo hi && python3 -c \"print(1)\"", ["echo", "python3"]],
            ["grep foo file.txt || echo \"not found\" >/dev/null", ["grep", "echo"]],
            ["git status && uv run pytest || true", ["git", "uv"]],
            ["find . -name '*.ts' | xargs grep foo 2>/dev/null || true", ["find", "xargs"]],
            ["echo hi\nls", ["echo", "ls"]],
        ])("parses %j", (command, expected) => {
            expect(extractCommands(command)).toEqual(expected);
        });
    });

    describe("assignments, comments, and quoting", () => {
        it.each([
            ["VAR=1 foo bar", ["foo"]],
            ["FOO=bar BAZ=qux cmd --flag", ["cmd"]],
            ["a=1 b=2", []],
            ["export FOO=bar; cmd", ["export", "cmd"]],
            ["echo \"# not a comment\"", ["echo"]],
            ["echo hi # comment", ["echo"]],
            ["echo hi # comment\nls -la", ["echo", "ls"]],
            ["python3 -c 'print(\"a;b\")'", ["python3"]],
            ["echo $((1<<2))", ["echo"]],
            ["echo $FOO", ["echo"]],
            ["echo $(git rev-parse HEAD)", ["echo", "git"]],
        ])("parses %j", (command, expected) => {
            expect(extractCommands(command)).toEqual(expected);
        });
    });

    describe("subshells and process substitution", () => {
        it.each([
            ["(cd foo && ls)", ["cd", "ls"]],
            ["(cmd1; cmd2)", ["cmd1", "cmd2"]],
            ["cmd < <(other)", ["cmd", "other"]],
        ])("parses %j", (command, expected) => {
            expect(extractCommands(command)).toEqual(expected);
        });
    });

    it("does not report redirection operators or targets", () => {
        for (const [command, expected] of [
            ["foo 2>/dev/null", ["foo"]],
            ["foo 2>&1", ["foo"]],
        ] as const) {
            const commands = extractCommands(command);
            expect(commands).toEqual(expected);
            expect(commands).not.toContain(">");
            expect(commands).not.toContain("2");
        }
    });
});

describe("sanitizeCommand", () => {
    it("replaces top-level newlines with separators", () => {
        expect(sanitizeCommand("echo hi\nls")).toBe("echo hi;\nls");
    });

    it("removes heredoc bodies", () => {
        expect(sanitizeCommand("python3 - <<'PY'\nprint(1)\nPY")).toBe("python3 - ;\n");
    });

    it("preserves newlines inside quotes", () => {
        expect(sanitizeCommand("echo \"a\nb\"")).toBe("echo \"a\nb\"");
    });

    it("strips comments but keeps separators", () => {
        expect(sanitizeCommand("echo hi # comment\nls")).toBe("echo hi ;\nls");
    });

    it("does not treat arithmetic shifts as heredocs", () => {
        expect(sanitizeCommand("echo $((1<<2))")).toBe("echo $((1<<2))");
    });
});
