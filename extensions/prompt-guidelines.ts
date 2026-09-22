// Helpers for contributing to pi's `promptGuidelines` in a cache-friendly way.
//
// Pi diffs the generated prompt sections against what the model already has and
// patches only the sections that changed. The `rules` section is rendered from
// `promptGuidelines` in array order, so a change in that order rewrites the
// whole section and costs a cache miss — even when the set of guidelines is
// unchanged. Inserting guidelines in a canonical (sorted) order makes the
// rendered section independent of extension load order, so the same set always
// produces the same text.
//
// The module is intentionally pure and free of SDK imports so it can be
// unit-tested directly.

/**
 * Adds `guideline` to `promptGuidelines`, keeping the list unique and sorted.
 *
 * Callers that run in `before_agent_start` start from a fresh copy of the
 * collection each turn, so this keeps the resulting `rules` section stable
 * across turns regardless of which extension registers its guideline first.
 */
export function addPromptGuideline(promptGuidelines: string[], guideline: string): void {
	if (promptGuidelines.includes(guideline)) return;
	promptGuidelines.push(guideline);
	promptGuidelines.sort();
}
