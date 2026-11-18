import { describe, expect, it } from "vitest";
import { truncate } from "../src/main";

/**
 * Characterization tests for `truncate` (main.ts:1919) — pins current
 * behaviour.
 */
describe("truncate", () => {
	it("returns the text unchanged when it fits within max", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("returns the text unchanged when it exactly equals max", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});

	it("is a no-op for a zero max", () => {
		expect(truncate("hello world", 0)).toBe("hello world");
	});

	it("is a no-op for a negative max", () => {
		expect(truncate("hello world", -1)).toBe("hello world");
	});

	it("truncates and appends an ellipsis when text exceeds max", () => {
		expect(truncate("hello world", 5)).toBe("hello…");
	});

	it("trims trailing whitespace left by the slice before appending the ellipsis", () => {
		expect(truncate("hello world", 6)).toBe("hello…");
	});
});
