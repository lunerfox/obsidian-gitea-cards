import { describe, expect, it } from "vitest";
import { milestoneProgressPercent } from "../src/main";

/**
 * Characterization tests for `milestoneProgressPercent` (main.ts:1564) —
 * pins current behaviour.
 */
describe("milestoneProgressPercent", () => {
	it("returns 0 for an empty milestone instead of dividing by zero", () => {
		expect(milestoneProgressPercent(0, 0)).toBe(0);
	});

	it("returns 0 for all-open issues", () => {
		expect(milestoneProgressPercent(10, 0)).toBe(0);
	});

	it("returns 100 for all-closed issues", () => {
		expect(milestoneProgressPercent(0, 10)).toBe(100);
	});

	it("returns an even split as 50", () => {
		expect(milestoneProgressPercent(5, 5)).toBe(50);
	});

	it("rounds a non-exact percentage to the nearest integer", () => {
		expect(milestoneProgressPercent(1, 2)).toBe(67); // 66.67 -> 67
		expect(milestoneProgressPercent(2, 1)).toBe(33); // 33.33 -> 33
	});

	it("treats a non-positive total (e.g. negative inputs) as empty", () => {
		expect(milestoneProgressPercent(-5, -5)).toBe(0);
	});
});
