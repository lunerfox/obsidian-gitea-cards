import { describe, expect, it } from "vitest";
import { splitRepo } from "../src/main";

/**
 * Characterization tests for `splitRepo` (main.ts:1150) — pins current
 * behaviour.
 */
describe("splitRepo", () => {
	it("splits an owner/repo slug", () => {
		expect(splitRepo("lunerfox/obsidian-gitea-cards")).toEqual({
			owner: "lunerfox",
			repo: "obsidian-gitea-cards",
		});
	});

	it("trims surrounding whitespace", () => {
		expect(splitRepo("  a/b  ")).toEqual({ owner: "a", repo: "b" });
	});

	it("returns null without a slash", () => {
		expect(splitRepo("ownerrepo")).toBeNull();
	});

	it("returns null with more than one slash", () => {
		expect(splitRepo("a/b/c")).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(splitRepo("")).toBeNull();
	});

	it("returns null when either side contains whitespace", () => {
		expect(splitRepo("a b/c")).toBeNull();
		expect(splitRepo("a/b c")).toBeNull();
	});
});
