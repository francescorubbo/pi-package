import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Key,
    matchesKey,
    type SelectItem,
    SelectList,
    type SelectListTheme,
    type TUI,
    truncateToWidth,
    type TuiMouseEvent,
    type TuiMouseEventResult,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { DECISION_OPTIONS } from "./shell-command-policy.js";

/** Lines of terminal chrome that the dialog adds around the scrollable details. */
function chromeLineCount(optionCount: number): number {
    return (
        1 + // top border
        1 + // title
        1 + // spacer
        1 + // scroll indicator
        1 + // spacer above the options
        optionCount +
        1 + // spacer below the options
        1 + // key hints
        1 // bottom border
    );
}

/**
 * Approval dialog for a blocked shell command.
 *
 * The command can be arbitrarily long, so it is rendered in a viewport that is
 * capped to the terminal height and scrollable with PgUp/PgDn (and Ctrl+U/
 * Ctrl+D, Home/End, mouse wheel). The decision options are rendered outside of
 * that viewport, so they stay visible and reachable no matter how long the
 * command is.
 *
 * Only `@earendil-works/pi-tui` is imported at runtime (the theme is a type-only
 * import), so the dialog can be rendered from tests without loading pi itself.
 */
export class ShellCommandApprovalDialog implements Component {
    private readonly list: SelectList;
    private detailLines: string[] = [];
    private detailLinesWidth = -1;
    private scrollOffset = 0;
    private viewportHeight = 0;

    constructor(
        private readonly tui: TUI,
        private readonly theme: Theme,
        selectListTheme: SelectListTheme,
        private readonly command: string,
        private readonly executable: string,
        private readonly done: (value: string | undefined) => void,
    ) {
        const items: SelectItem[] = DECISION_OPTIONS.map((option) => ({
            value: option.label,
            label: option.label,
            description: option.description,
        }));

        this.list = new SelectList(items, items.length, selectListTheme);
        this.list.onSelect = (item) => this.done(item.value);
        this.list.onCancel = () => this.done(undefined);
    }

    private getDetailLines(width: number): string[] {
        if (this.detailLinesWidth === width) return this.detailLines;

        const theme = this.theme;
        const commandLines = wrapTextWithAnsi(this.command, width).map((line) => theme.fg("text", line));
        this.detailLines = [
            theme.fg("muted", "Command:"),
            ...commandLines,
            "",
            `${theme.fg("muted", "Unauthorized executable:")} ${theme.fg("accent", theme.bold(this.executable))}`,
        ];
        this.detailLinesWidth = width;
        return this.detailLines;
    }

    private maxScrollOffset(): number {
        return Math.max(0, this.detailLines.length - this.viewportHeight);
    }

    private scrollBy(lines: number): void {
        const next = Math.max(0, Math.min(this.maxScrollOffset(), this.scrollOffset + lines));
        if (next === this.scrollOffset) return;
        this.scrollOffset = next;
        this.tui.requestRender();
    }

    private scrollTo(offset: number): void {
        const next = Math.max(0, Math.min(this.maxScrollOffset(), offset));
        if (next === this.scrollOffset) return;
        this.scrollOffset = next;
        this.tui.requestRender();
    }

    render(width: number): string[] {
        const theme = this.theme;
        const totalWidth = Math.max(1, width);
        const contentWidth = Math.max(1, totalWidth - 4);
        const indent = (line: string): string => `  ${line}`;
        const border = theme.fg("border", "─".repeat(totalWidth));

        const details = this.getDetailLines(contentWidth);
        const options = this.list.render(contentWidth);
        const chrome = chromeLineCount(options.length);
        const rows = this.tui.terminal?.rows ?? 30;
        const maxViewport = Math.max(3, rows - chrome - 1);
        this.viewportHeight = Math.max(1, Math.min(details.length, maxViewport));

        const maxScroll = this.maxScrollOffset();
        this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
        const visible = details.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);

        return [
            border,
            indent(truncateToWidth(theme.fg("warning", theme.bold("Shell command blocked")), contentWidth)),
            "",
            indent(truncateToWidth(this.scrollIndicator(details.length, maxScroll), contentWidth)),
            ...visible.map(indent),
            "",
            ...options.map(indent),
            "",
            indent(truncateToWidth(this.keyHints(maxScroll > 0), contentWidth)),
            border,
        ];
    }

    private scrollIndicator(totalLines: number, maxScroll: number): string {
        if (maxScroll <= 0) return "";
        const first = this.scrollOffset + 1;
        const last = Math.min(totalLines, this.scrollOffset + this.viewportHeight);
        return this.theme.fg("dim", `lines ${first}-${last} of ${totalLines}`);
    }

    private keyHints(scrollable: boolean): string {
        const hints = [
            "↑↓ select",
            ...(scrollable ? ["PgUp/PgDn scroll"] : []),
            "enter confirm",
            "esc block",
        ];
        return this.theme.fg("dim", hints.join(" · "));
    }

    handleInput(data: string): void {
        const page = Math.max(1, this.viewportHeight - 1);
        if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
            this.scrollBy(-page);
            return;
        }
        if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
            this.scrollBy(page);
            return;
        }
        if (matchesKey(data, Key.home)) {
            this.scrollTo(0);
            return;
        }
        if (matchesKey(data, Key.end)) {
            this.scrollTo(Number.MAX_SAFE_INTEGER);
            return;
        }

        this.list.handleInput(data);
        this.tui.requestRender();
    }

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        if (event.type !== "wheel" || !event.wheelDelta) return undefined;
        this.scrollBy(Math.sign(event.wheelDelta) * 3);
        return { handled: true };
    }

    invalidate(): void {
        this.detailLinesWidth = -1;
        this.list.invalidate();
    }
}
