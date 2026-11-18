import { describe, expect, it } from "vitest";
import { escapeRegExp } from "../src/main";

/**
 * Characterization tests for `escapeRegExp` (main.ts:1138) — pins current
 * behaviour.
 */
describe("escapeRegExp", () => {
	it("escapes every regex metacharacter", () => {
		expect(escapeRegExp(".*+?^${}()|[]\\")).toBe(
			"\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\"
		);
	});

	it("leaves plain alphanumeric text unchanged", () => {
		expect(escapeRegExp("GITEA123")).toBe("GITEA123");
	});

	it("produces a string usable as a literal match in a RegExp", () => {
		const escaped = escapeRegExp("a.b*c");
		expect(new RegExp(`^${escaped}$`).test("a.b*c")).toBe(true);
		expect(new RegExp(`^${escaped}$`).test("axbxc")).toBe(false);
	});
});
