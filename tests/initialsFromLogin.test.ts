import { describe, expect, it } from "vitest";
import { initialsFromLogin } from "../src/main";

/**
 * Characterization tests for `initialsFromLogin` (main.ts:1960) — pins
 * current behaviour.
 */
describe("initialsFromLogin", () => {
	it("takes the first two characters of a single word, uppercased", () => {
		expect(initialsFromLogin("lunerfox")).toBe("LU");
	});

	it("takes the first letter of each of the first two words", () => {
		expect(initialsFromLogin("leo szeto")).toBe("LS");
	});

	it("splits on dots, underscores, and hyphens like whitespace", () => {
		expect(initialsFromLogin("leo.szeto")).toBe("LS");
		expect(initialsFromLogin("leo_szeto")).toBe("LS");
		expect(initialsFromLogin("leo-szeto")).toBe("LS");
	});

	it("ignores a third and later word", () => {
		expect(initialsFromLogin("leo middle szeto")).toBe("LM");
	});

	it("drops empty segments from leading/trailing/doubled separators", () => {
		expect(initialsFromLogin("-leo-")).toBe("LE");
		expect(initialsFromLogin("leo--szeto")).toBe("LS");
	});

	it("returns a single uppercased character for a one-character login", () => {
		expect(initialsFromLogin("l")).toBe("L");
	});

	it("returns ? for an empty or all-separator login", () => {
		expect(initialsFromLogin("")).toBe("?");
		expect(initialsFromLogin("---")).toBe("?");
	});
});
