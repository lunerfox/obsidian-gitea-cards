import { describe, expect, it } from "vitest";
import { parseMilestoneQuery } from "../src/main";

/**
 * Characterization tests for `parseMilestoneQuery` (main.ts:1507) — pins
 * current behaviour, bugs included, as a baseline for later refactors.
 */
describe("parseMilestoneQuery", () => {
	it("parses a valid repo + milestone", () => {
		const { query, error } = parseMilestoneQuery(
			"repo: lunerfox/gitea-cards\nmilestone: v1"
		);
		expect(error).toBeNull();
		expect(query).toEqual({ repo: "lunerfox/gitea-cards", milestone: "v1" });
	});

	it("skips blank lines", () => {
		const { query, error } = parseMilestoneQuery(
			"\nrepo: a/b\n\nmilestone: v1\n"
		);
		expect(error).toBeNull();
		expect(query).toEqual({ repo: "a/b", milestone: "v1" });
	});

	it("is case-insensitive on keys, case-preserving on values", () => {
		const { query, error } = parseMilestoneQuery(
			"REPO: Owner/Repo\nMILESTONE: Phase One"
		);
		expect(error).toBeNull();
		expect(query).toEqual({ repo: "Owner/Repo", milestone: "Phase One" });
	});

	it("keeps only text after the first colon in a value", () => {
		const { query, error } = parseMilestoneQuery(
			"repo: a/b\nmilestone: v1: beta"
		);
		expect(error).toBeNull();
		expect(query?.milestone).toBe("v1: beta");
	});

	it('rejects a line with no ":" separator (the shared sep === -1 branch)', () => {
		const { query, error } = parseMilestoneQuery("not-a-key-value-line");
		expect(query).toBeNull();
		expect(error).toBe('Expected "key: value" lines; got "not-a-key-value-line".');
	});

	it("rejects an unknown field", () => {
		const { query, error } = parseMilestoneQuery(
			"repo: a/b\nmilestone: v1\nbogus: value"
		);
		expect(query).toBeNull();
		expect(error).toBe('Unknown field "bogus".');
	});

	it("errors on a missing repo before anything else", () => {
		const { query, error } = parseMilestoneQuery("milestone: v1");
		expect(query).toBeNull();
		expect(error).toBe("Missing repo — add a repo: owner/repo line.");
	});

	it("errors on a completely empty body as a missing repo", () => {
		const { query, error } = parseMilestoneQuery("");
		expect(query).toBeNull();
		expect(error).toBe("Missing repo — add a repo: owner/repo line.");
	});

	it("checks repo format before checking for a missing milestone", () => {
		// Bug/quirk-adjacent ordering: an invalid repo shadows a missing
		// milestone — you only find out about the milestone once repo is fixed.
		const { query, error } = parseMilestoneQuery("repo: not-valid");
		expect(query).toBeNull();
		expect(error).toBe('Invalid repo "not-valid" — use owner/repo.');
	});

	it("rejects a repo that doesn't look like owner/repo", () => {
		const { query, error } = parseMilestoneQuery(
			"repo: not-valid\nmilestone: v1"
		);
		expect(query).toBeNull();
		expect(error).toBe('Invalid repo "not-valid" — use owner/repo.');
	});

	it("errors on a missing milestone once the repo is valid", () => {
		const { query, error } = parseMilestoneQuery("repo: a/b");
		expect(query).toBeNull();
		expect(error).toBe("Missing milestone — add a milestone: name line.");
	});

	it("treats an empty repo value the same as a missing repo", () => {
		const { query, error } = parseMilestoneQuery("repo:\nmilestone: v1");
		expect(query).toBeNull();
		expect(error).toBe("Missing repo — add a repo: owner/repo line.");
	});

	it("treats an empty milestone value the same as a missing milestone", () => {
		const { query, error } = parseMilestoneQuery("repo: a/b\nmilestone:");
		expect(query).toBeNull();
		expect(error).toBe("Missing milestone — add a milestone: name line.");
	});

	it("uses the last repo/milestone line when a key repeats", () => {
		const { query, error } = parseMilestoneQuery(
			"repo: a/b\nrepo: c/d\nmilestone: v1\nmilestone: v2"
		);
		expect(error).toBeNull();
		expect(query).toEqual({ repo: "c/d", milestone: "v2" });
	});
});
