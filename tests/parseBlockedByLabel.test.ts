import { describe, expect, it } from "vitest";
import { parseBlockedByLabel } from "../src/main";

/**
 * Characterization tests for `parseBlockedByLabel` (main.ts:1976) — pins
 * current behaviour. The issue-processor's `blocked-by:#N` label convention.
 */
describe("parseBlockedByLabel", () => {
	it("parses the blocker index out of a well-formed label", () => {
		expect(parseBlockedByLabel("blocked-by:#5")).toBe(5);
	});

	it("parses a zero-padded index", () => {
		expect(parseBlockedByLabel("blocked-by:#05")).toBe(5);
	});

	it("trims surrounding whitespace before matching", () => {
		expect(parseBlockedByLabel("  blocked-by:#5  ")).toBe(5);
	});

	it("returns null for an ordinary label", () => {
		expect(parseBlockedByLabel("bug")).toBeNull();
	});

	it("returns null without the # sigil", () => {
		expect(parseBlockedByLabel("blocked-by:5")).toBeNull();
	});

	it("returns null for trailing garbage after the digits", () => {
		expect(parseBlockedByLabel("blocked-by:#3-ish")).toBeNull();
	});

	it("is case-sensitive — an uppercase prefix does not match", () => {
		expect(parseBlockedByLabel("BLOCKED-BY:#5")).toBeNull();
	});

	it("returns null for a non-numeric index", () => {
		expect(parseBlockedByLabel("blocked-by:#abc")).toBeNull();
	});
});
