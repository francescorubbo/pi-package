import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SelectListTheme, TUI } from "@earendil-works/pi-tui";
import { ShellCommandApprovalDialog } from "../extensions/shell-command-dialog.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const selectListTheme: SelectListTheme = {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
};

function createDialog(command: string, executable: string, rows = 24) {
    const renders: number[] = [];
    const results: (string | undefined)[] = [];
    const tui = {
        terminal: { rows },
        requestRender: () => renders.push(rows),
    } as unknown as TUI;
    const dialog = new ShellCommandApprovalDialog(tui, theme, selectListTheme, command, executable, (value) =>
        results.push(value)
    );
    const render = (width = 80): string[] => dialog.render(width).map(stripAnsi);
    return { dialog, render, results, requestRenderCount: () => renders.length };
}

const longCommand = `uv run ${Array.from({ length: 300 }, (_, i) => `--flag${i}=value${i}`).join(" ")}`;
const lastToken = "value299";

describe("ShellCommandApprovalDialog", () => {
    it("keeps every decision option visible for a command longer than the terminal", () => {
        const { render } = createDialog(longCommand, "uv");
        const output = render().join("\n");
        expect(output).toContain("PgUp/PgDn scroll");

        expect(output).toContain("Allow once");
        expect(output).toContain("Always allow (Project)");
        expect(output).toContain("Always allow (Global)");
        expect(output).toContain("Block");
    });

    it("never renders taller than the terminal", () => {
        const rows = 24;
        const { render } = createDialog(longCommand, "uv", rows);
        expect(render().length).toBeLessThanOrEqual(rows);
    });

    it("wraps and scrolls long commands so the whole command can be inspected", () => {
        const { dialog, render } = createDialog(longCommand, "uv");
        const firstScreen = render().join("\n");
        expect(firstScreen).toContain("--flag0=value0");
        expect(firstScreen).toMatch(/lines 1-\d+ of \d+/);
        expect(firstScreen).not.toContain(lastToken);

        // Page down until the end of the command is on screen.
        let output = firstScreen;
        for (let i = 0; i < 1000 && !output.includes(lastToken); i++) {
            dialog.handleInput(PAGE_DOWN);
            output = render().join("\n");
        }

        expect(output).toContain(lastToken);
        expect(output).toContain("Unauthorized executable:");
        // Options stay visible while scrolled to the bottom.
        expect(output).toContain("Block");
    });

    it("scrolls back to the top with page up", () => {
        const { dialog, render } = createDialog(longCommand, "uv");
        render(); // the real TUI renders before routing input to the dialog
        const pages = 3;
        for (let i = 0; i < pages; i++) dialog.handleInput(PAGE_DOWN);
        expect(render().join("\n")).not.toContain("--flag0=value0");

        for (let i = 0; i < pages; i++) dialog.handleInput(PAGE_UP);
        expect(render().join("\n")).toContain("--flag0=value0");
    });

    it("resolves with the selected option", () => {
        const { dialog, results } = createDialog("git status", "git");
        dialog.render(80);
        dialog.handleInput("\r");
        expect(results).toEqual(["Allow once"]);
    });

    it("resolves with undefined when the dialog is dismissed", () => {
        const { dialog, results } = createDialog("git status", "git");
        dialog.render(80);
        dialog.handleInput("\x1b");
        expect(results).toEqual([undefined]);
    });

    it("renders nothing longer than the requested width", () => {
        const { dialog } = createDialog(longCommand, "uv");
        const lines = dialog.render(60);
        // strip only ANSI codes; visible width must fit the requested width
        for (const line of lines) {
            expect(stripAnsi(line).length).toBeLessThanOrEqual(60);
        }
    });
});
