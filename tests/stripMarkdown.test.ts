import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../src/main";

/**
 * Characterization tests for `stripMarkdown` (main.ts:1905) — pins current
 * behaviour. Reduces an issue body to a single plain-text line: first line
 * only, leading heading/quote/list marker dropped, links/code/emphasis
 * unwrapped, whitespace collapsed.
 */
describe("stripMarkdown", () => {
	it("takes only the first line", () => {
		expect(stripMarkdown("first line\nsecond line")).toBe("first line");
	});

	it("drops a leading heading marker", () => {
		expect(stripMarkdown("# Title")).toBe("Title");
		expect(stripMarkdown("###### Title")).toBe("Title");
	});

	it("drops a leading blockquote marker", () => {
		expect(stripMarkdown("> quoted text")).toBe("quoted text");
	});

	it.each(["-", "*", "+"])("drops a leading %s list marker", (marker) => {
		expect(stripMarkdown(`${marker} item`)).toBe("item");
	});

	it("tolerates up to 3 leading spaces before the marker", () => {
		expect(stripMarkdown("   # Title")).toBe("Title");
	});

	it("does not strip a marker indented 4 or more spaces (code-block indent)", () => {
		expect(stripMarkdown("    # Title")).toBe("# Title");
	});

	it("unwraps a markdown link to its label", () => {
		expect(stripMarkdown("see [the docs](https://example.com) for more")).toBe(
			"see the docs for more"
		);
	});

	it("unwraps a markdown image to its alt text", () => {
		expect(stripMarkdown("![alt text](https://example.com/x.png)")).toBe("alt text");
	});

	it("unwraps inline code", () => {
		expect(stripMarkdown("run `npm test` now")).toBe("run npm test now");
	});

	it("strips emphasis markers without unwrapping their content specially", () => {
		expect(stripMarkdown("*bold* _em_ ~strike~")).toBe("bold em strike");
	});

	it("collapses internal whitespace runs to a single space", () => {
		expect(stripMarkdown("a   b\tc")).toBe("a b c");
	});

	it("trims leading and trailing whitespace", () => {
		expect(stripMarkdown("  padded  ")).toBe("padded");
	});

	it("returns an empty string for an empty body", () => {
		expect(stripMarkdown("")).toBe("");
	});
});
