import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteCommand } from "../extensions/pi-uv.js";

describe("rewriteCommand", () => {
    // `cwd` has a uv.lock itself; the rest are containers for project detection.
    let cwd: string;
    let repo: string;
    let scanRepo: string;
    let spaceRepo: string;
    const created: string[] = [];

    function makeRoot(prefix: string): string {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        created.push(dir);
        return dir;
    }

    beforeAll(() => {
        cwd = makeRoot("pi-uv-cwd-");
        writeFileSync(join(cwd, "uv.lock"), "");

        repo = makeRoot("pi-uv-repo-");
        mkdirSync(join(repo, "project-a"), { recursive: true });
        writeFileSync(join(repo, "project-a", "uv.lock"), "");

        scanRepo = makeRoot("pi-uv-scan-");
        mkdirSync(join(scanRepo, "solo"), { recursive: true });
        writeFileSync(join(scanRepo, "solo", "uv.lock"), "");

        spaceRepo = makeRoot("pi-uv-space-");
        mkdirSync(join(spaceRepo, "project space"), { recursive: true });
        writeFileSync(join(spaceRepo, "project space", "uv.lock"), "");
    });

    afterAll(() => {
        for (const dir of created) rmSync(dir, { recursive: true, force: true });
    });

    describe("with a uv project at the CWD", () => {
        it.each([
            ["python main.py", "uv run --project . python main.py"],
            [".venv/bin/python main.py", "uv run --project . python main.py"],
            ["/usr/bin/python3 script.py", "uv run --project . python3 script.py"],
            ["python3.12 app.py", "uv run --project . python3.12 app.py"],
            ["pytest -q", "uv run --project . pytest -q"],
            ["FOO=bar python x.py", "FOO=bar uv run --project . python x.py"],
            [
                "cd sub && .venv/bin/python main.py",
                "cd sub && uv run --project . python main.py",
            ],
            [
                "python a.py && pytest",
                "uv run --project . python a.py && uv run --project . pytest",
            ],
            [
                "python3 - <<'PY'\nprint(1)\nPY",
                "uv run --project . python3 - <<'PY'\nprint(1)\nPY",
            ],
        ])("rewrites %j", (command, expected) => {
            expect(rewriteCommand(command, cwd)).toBe(expected);
        });

        it.each([
            ["git status"],
            ["echo python"],
            ["uv run --project . python x.py"],
            ["uvx ruff check"],
        ])("leaves %j untouched", (command) => {
            expect(rewriteCommand(command, cwd)).toBeNull();
        });
    });

    describe("project detection", () => {
        it("uses a path argument to find the project root", () => {
            expect(rewriteCommand("python project-a/main.py", repo)).toBe(
                "uv run --project project-a python project-a/main.py",
            );
        });

        it("scans subdirectories when the path argument has no separator", () => {
            expect(rewriteCommand("cd solo && .venv/bin/python main.py", scanRepo)).toBe(
                "cd solo && uv run --project solo python main.py",
            );
        });

        it("quotes a project path containing spaces", () => {
            expect(rewriteCommand('python "project space/main.py"', spaceRepo)).toBe(
                'uv run --project "project space" python "project space/main.py"',
            );
        });
    });
});
