import { describe, expect, it } from "vitest";
import { labelTextColor } from "../src/main";

/**
 * Characterization tests for `labelTextColor` (main.ts:1985) — pins current
 * behaviour, including the exact luminance boundary and the default for
 * malformed hex input.
 */
describe("labelTextColor", () => {
	it("picks black text on a white background", () => {
		expect(labelTextColor("ffffff")).toBe("#000000");
	});

	it("picks white text on a black background", () => {
		expect(labelTextColor("000000")).toBe("#ffffff");
	});

	it("accepts a leading #", () => {
		expect(labelTextColor("#ffffff")).toBe("#000000");
	});

	it("defaults to white text when the hex is not 6 digits", () => {
		expect(labelTextColor("fff")).toBe("#ffffff");
		expect(labelTextColor("#abcde")).toBe("#ffffff");
		expect(labelTextColor("")).toBe("#ffffff");
	});

	it("defaults to white text for non-hex characters (NaN luminance)", () => {
		expect(labelTextColor("zzzzzz")).toBe("#ffffff");
	});

	it("stays white at exactly the 0.6 luminance boundary (not >=)", () => {
		expect(labelTextColor("999999")).toBe("#ffffff");
	});

	it("flips to black just above the 0.6 luminance boundary", () => {
		expect(labelTextColor("9a9a9a")).toBe("#000000");
	});

	it("is case-insensitive on the hex digits", () => {
		expect(labelTextColor("FFFFFF")).toBe("#000000");
	});
});
