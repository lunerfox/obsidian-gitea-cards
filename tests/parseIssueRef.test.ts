import { describe, expect, it } from "vitest";
import { parseIssueRef } from "../src/main";

/**
 * Characterization tests for `parseIssueRef` (main.ts:584) — pins current
 * behaviour.
 */
describe("parseIssueRef", () => {
	it("parses an owner/repo#index reference", () => {
		expect(parseIssueRef("lunerfox/obsidian-gitea-cards#73")).toEqual({
			owner: "lunerfox",
			repo: "obsidian-gitea-cards",
			index: 73,
		});
	});

	it("trims surrounding whitespace", () => {
		expect(parseIssueRef("  a/b#1  ")).toEqual({ owner: "a", repo: "b", index: 1 });
	});

	it("allows the repo segment to contain a slash — unlike splitRepo", () => {
		expect(parseIssueRef("a/b/c#1")).toEqual({ owner: "a", repo: "b/c", index: 1 });
	});

	it("returns null without a # separator", () => {
		expect(parseIssueRef("a/b")).toBeNull();
	});

	it("returns null without a slash", () => {
		expect(parseIssueRef("ab#1")).toBeNull();
	});

	it("returns null for a non-numeric index", () => {
		expect(parseIssueRef("a/b#abc")).toBeNull();
	});

	it("returns null for multi-line input", () => {
		expect(parseIssueRef("a/b#1\nc/d#2")).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(parseIssueRef("")).toBeNull();
	});
});
