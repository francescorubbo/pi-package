/**
 * Decision model for the shell command blocker.
 *
 * Kept free of pi/ui imports so it can be unit-tested and reused by both the
 * terminal dialog and the plain `select()` fallback used in other UI modes.
 */

export type ShellDecision = "allow-once" | "allow-project" | "allow-global" | "block";

export interface DecisionOption {
    /** Label shown in the dialog. Also the value returned by `ctx.ui.select()`. */
    label: string;
    /** Short explanation shown below the label. */
    description: string;
    decision: ShellDecision;
}

export const DECISION_OPTIONS: readonly DecisionOption[] = [
    {
        label: "Allow once",
        description: "run this command now, ask again next time",
        decision: "allow-once",
    },
    {
        label: "Always allow (Project)",
        description: "add the executable to this project's allowlist",
        decision: "allow-project",
    },
    {
        label: "Always allow (Global)",
        description: "add the executable to the global allowlist",
        decision: "allow-global",
    },
    {
        label: "Block",
        description: "reject the command",
        decision: "block",
    },
];

/** Labels in the order the options must be shown. */
export const DECISION_LABELS: readonly string[] = DECISION_OPTIONS.map((option) => option.label);

/**
 * Maps a dialog response to a decision. Anything that is not a known label
 * (dismissed dialog, no UI available, unexpected value) blocks the command,
 * which is the safe default for this extension.
 */
export function toDecision(response: string | undefined | null): ShellDecision {
    return DECISION_OPTIONS.find((option) => option.label === response)?.decision ?? "block";
}
