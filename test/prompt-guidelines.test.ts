import { describe, expect, it } from "vitest";
import { addPromptGuideline } from "../extensions/prompt-guidelines.js";

describe("addPromptGuideline", () => {
	it("adds a new guideline", () => {
		const guidelines: string[] = [];
		addPromptGuideline(guidelines, "Use bash carefully.");
		expect(guidelines).toEqual(["Use bash carefully."]);
	});

	it("does not add duplicates", () => {
		const guidelines: string[] = ["Use bash carefully."];
		addPromptGuideline(guidelines, "Use bash carefully.");
		expect(guidelines).toEqual(["Use bash carefully."]);
	});

	it("keeps the collection sorted", () => {
		const guidelines: string[] = [];
		addPromptGuideline(guidelines, "Zebra rule");
		addPromptGuideline(guidelines, "Alpha rule");
		addPromptGuideline(guidelines, "Middle rule");
		expect(guidelines).toEqual(["Alpha rule", "Middle rule", "Zebra rule"]);
	});

	it("produces the same order regardless of extension load order", () => {
		const a = "Alpha rule";
		const b = "Bravo rule";
		const c = "Charlie rule";

		const first: string[] = [];
		addPromptGuideline(first, c);
		addPromptGuideline(first, a);
		addPromptGuideline(first, b);

		const second: string[] = [];
		addPromptGuideline(second, a);
		addPromptGuideline(second, b);
		addPromptGuideline(second, c);

		expect(first).toEqual(second);
		expect(first.join("\n")).toBe(second.join("\n"));
	});
});
