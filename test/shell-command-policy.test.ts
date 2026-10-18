import { describe, expect, it } from "vitest";
import { DECISION_OPTIONS, DECISION_LABELS, toDecision } from "../extensions/shell-command-policy.js";

describe("toDecision", () => {
    it.each(DECISION_OPTIONS.map((option) => [option.label, option.decision]))(
        "maps %j to %j",
        (label, decision) => {
            expect(toDecision(label)).toBe(decision);
        },
    );

    it("exposes labels in the display order", () => {
        expect(DECISION_LABELS).toEqual([
            "Allow once",
            "Always allow (Project)",
            "Always allow (Global)",
            "Block",
        ]);
    });

    it.each([undefined, null, "", "yes", "Allow once "])(
        "blocks on unknown response %j",
        (response) => {
            expect(toDecision(response)).toBe("block");
        },
    );
});
