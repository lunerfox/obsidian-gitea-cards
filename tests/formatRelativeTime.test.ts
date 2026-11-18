import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../src/main";

/**
 * Characterization tests for `formatRelativeTime` (main.ts:1927) — pins
 * current behaviour, including its rounding at each unit boundary.
 */
describe("formatRelativeTime", () => {
	const NOW = Date.parse("2026-01-15T12:00:00Z");

	function ago(ms: number): string {
		return new Date(NOW - ms).toISOString();
	}

	it("returns an empty string for an unparsable timestamp", () => {
		expect(formatRelativeTime("not-a-date", NOW)).toBe("");
	});

	it("clamps a future timestamp to 0 seconds rather than going negative", () => {
		expect(formatRelativeTime(ago(-60_000), NOW)).toBe("just now");
	});

	it("reports under 45 seconds as just now", () => {
		expect(formatRelativeTime(ago(30_000), NOW)).toBe("just now");
		expect(formatRelativeTime(ago(44_000), NOW)).toBe("just now");
	});

	it("rounds 45 seconds up into minutes rather than staying just now", () => {
		expect(formatRelativeTime(ago(45_000), NOW)).toBe("1m ago");
	});

	it("reports minutes under an hour", () => {
		expect(formatRelativeTime(ago(5 * 60_000), NOW)).toBe("5m ago");
	});

	it("reports hours under a day", () => {
		expect(formatRelativeTime(ago(3 * 3_600_000), NOW)).toBe("3h ago");
	});

	it("reports days under a week", () => {
		expect(formatRelativeTime(ago(3 * 86_400_000), NOW)).toBe("3d ago");
	});

	it("reports weeks under 5 weeks", () => {
		expect(formatRelativeTime(ago(10 * 86_400_000), NOW)).toBe("1w ago");
	});

	it("falls through to months once the week count reaches 5", () => {
		// 40 days: weeks = round(40/7) = 6 (not < 5), months = round(40/30) = 1.
		expect(formatRelativeTime(ago(40 * 86_400_000), NOW)).toBe("1mo ago");
	});

	it("reports months under a year", () => {
		expect(formatRelativeTime(ago(200 * 86_400_000), NOW)).toBe("7mo ago");
	});

	it("falls through to years once the month count reaches 12", () => {
		expect(formatRelativeTime(ago(400 * 86_400_000), NOW)).toBe("1y ago");
	});

	it("uses Date.now() when now is omitted", () => {
		expect(formatRelativeTime(new Date().toISOString())).toBe("just now");
	});
});
