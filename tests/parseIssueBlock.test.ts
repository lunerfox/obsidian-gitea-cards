import { describe, expect, it } from "vitest";
import { COMMENTS_MAX_PREVIEW, parseIssueBlock } from "../src/main";

/**
 * Characterization tests for `parseIssueBlock` (main.ts:618) — pins current
 * behaviour (issue #40's `comments:` auto-expand convention).
 */
describe("parseIssueBlock", () => {
	it("parses a bare reference with a collapsed thread", () => {
		const { block, error } = parseIssueBlock("lunerfox/obsidian-gitea-cards#73");
		expect(error).toBeNull();
		expect(block).toEqual({
			ref: { owner: "lunerfox", repo: "obsidian-gitea-cards", index: 73 },
			comments: null,
		});
	});

	it("skips blank lines", () => {
		const { block, error } = parseIssueBlock("\n  \na/b#1\n\n");
		expect(error).toBeNull();
		expect(block?.ref).toEqual({ owner: "a", repo: "b", index: 1 });
	});

	it("auto-expands with a positive comments count, capped at COMMENTS_MAX_PREVIEW", () => {
		const { block, error } = parseIssueBlock(`a/b#1\ncomments: ${COMMENTS_MAX_PREVIEW + 50}`);
		expect(error).toBeNull();
		expect(block?.comments).toBe(COMMENTS_MAX_PREVIEW);
	});

	it("accepts a comments count under the cap unchanged", () => {
		const { block, error } = parseIssueBlock("a/b#1\ncomments: 5");
		expect(error).toBeNull();
		expect(block?.comments).toBe(5);
	});

	it("auto-expands with the default count (0) for an empty comments value", () => {
		const { block, error } = parseIssueBlock("a/b#1\ncomments:");
		expect(error).toBeNull();
		expect(block?.comments).toBe(0);
	});

	it("auto-expands with the default count (0) for a zero or negative comments value", () => {
		expect(parseIssueBlock("a/b#1\ncomments: 0").block?.comments).toBe(0);
		expect(parseIssueBlock("a/b#1\ncomments: -5").block?.comments).toBe(0);
	});

	it("rejects an unknown field", () => {
		const { block, error } = parseIssueBlock("a/b#1\nbogus: value");
		expect(block).toBeNull();
		expect(error).toBe('Unknown field "bogus".');
	});

	it('rejects a non-ref line with no ":" separator', () => {
		const { block, error } = parseIssueBlock("a/b#1\nnot-a-key-value-line");
		expect(block).toBeNull();
		expect(error).toBe('Expected owner/repo#index or "key: value"; got "not-a-key-value-line".');
	});

	it("rejects a block with no reference at all", () => {
		const { block, error } = parseIssueBlock("comments: 5");
		expect(block).toBeNull();
		expect(error).toBe("Expected a single reference in owner/repo#index form.");
	});

	it("rejects an empty block", () => {
		const { block, error } = parseIssueBlock("");
		expect(block).toBeNull();
		expect(error).toBe("Expected a single reference in owner/repo#index form.");
	});

	it("uses the last reference line when more than one is present", () => {
		const { block, error } = parseIssueBlock("a/b#1\nc/d#2");
		expect(error).toBeNull();
		expect(block?.ref).toEqual({ owner: "c", repo: "d", index: 2 });
	});
});
