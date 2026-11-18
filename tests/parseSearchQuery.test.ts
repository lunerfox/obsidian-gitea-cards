import { describe, expect, it } from "vitest";
import {
	SEARCH_DEFAULT_LIMIT,
	SEARCH_MAX_LIMIT,
	parseSearchQuery,
} from "../src/main";

/**
 * Characterization tests for `parseSearchQuery` (main.ts:1321) — pins current
 * behaviour, including its quirks, as a baseline for later refactors. These
 * tests describe what the function *does*, not what it *should* do; bugs
 * found along the way are noted in comments rather than fixed.
 */
describe("parseSearchQuery", () => {
	it("defaults an empty body to a global open-issue search", () => {
		const { query, error } = parseSearchQuery("");
		expect(error).toBeNull();
		expect(query).toEqual({
			repo: null,
			state: "open",
			labels: [],
			milestones: [],
			assignee: null,
			q: null,
			limit: SEARCH_DEFAULT_LIMIT,
			layout: "table",
		});
	});

	it("skips blank lines", () => {
		const { query, error } = parseSearchQuery("\n  \nrepo: a/b\n\n");
		expect(error).toBeNull();
		expect(query?.repo).toBe("a/b");
	});

	it("parses repo as owner/repo", () => {
		const { query, error } = parseSearchQuery("repo: lunerfox/gitea-cards");
		expect(error).toBeNull();
		expect(query?.repo).toBe("lunerfox/gitea-cards");
	});

	it("treats an empty repo value as null rather than an empty string", () => {
		const { query, error } = parseSearchQuery("repo:");
		expect(error).toBeNull();
		expect(query?.repo).toBeNull();
	});

	it.each(["open", "closed", "all"])("accepts state %s", (state) => {
		const { query, error } = parseSearchQuery(`state: ${state}`);
		expect(error).toBeNull();
		expect(query?.state).toBe(state);
	});

	it("lowercases state", () => {
		const { query, error } = parseSearchQuery("state: OPEN");
		expect(error).toBeNull();
		expect(query?.state).toBe("open");
	});

	it("rejects an unknown state", () => {
		const { query, error } = parseSearchQuery("state: bogus");
		expect(query).toBeNull();
		expect(error).toBe('Unknown state "bogus" — use open, closed, or all.');
	});

	it.each(["label", "labels"])(
		"splits %s into a trimmed, non-empty list",
		(key) => {
			const { query, error } = parseSearchQuery(`${key}: bug, ui ,  , needs-triage`);
			expect(error).toBeNull();
			expect(query?.labels).toEqual(["bug", "ui", "needs-triage"]);
		}
	);

	it("does not merge repeated label lines — the last one wins", () => {
		const { query, error } = parseSearchQuery("label: bug\nlabel: ui");
		expect(error).toBeNull();
		expect(query?.labels).toEqual(["ui"]);
	});

	it.each(["milestone", "milestones"])(
		"splits %s into a trimmed, non-empty list",
		(key) => {
			const { query, error } = parseSearchQuery(`${key}: v1, v2`);
			expect(error).toBeNull();
			expect(query?.milestones).toEqual(["v1", "v2"]);
		}
	);

	it.each(["assignee", "assignees", "assigned"])(
		"accepts %s as an alias for the assignee filter",
		(key) => {
			const { query, error } = parseSearchQuery(`${key}: lunerfox`);
			expect(error).toBeNull();
			expect(query?.assignee).toBe("lunerfox");
		}
	);

	it("treats an empty assignee value as null", () => {
		const { query, error } = parseSearchQuery("assignee:");
		expect(error).toBeNull();
		expect(query?.assignee).toBeNull();
	});

	it.each(["q", "query"])("accepts %s as the free-text filter", (key) => {
		const { query, error } = parseSearchQuery(`${key}: inline chip bug`);
		expect(error).toBeNull();
		expect(query?.q).toBe("inline chip bug");
	});

	it("keeps only text after the first colon in a value", () => {
		// `indexOf(":")` finds the first colon only, so a value containing one
		// of its own is preserved verbatim rather than truncated.
		const { query, error } = parseSearchQuery("q: fix bug: crash on open");
		expect(error).toBeNull();
		expect(query?.q).toBe("fix bug: crash on open");
	});

	it("parses a valid limit, capped at SEARCH_MAX_LIMIT", () => {
		const { query, error } = parseSearchQuery(`limit: ${SEARCH_MAX_LIMIT + 50}`);
		expect(error).toBeNull();
		expect(query?.limit).toBe(SEARCH_MAX_LIMIT);
	});

	it("accepts a limit under the max unchanged", () => {
		const { query, error } = parseSearchQuery("limit: 5");
		expect(error).toBeNull();
		expect(query?.limit).toBe(5);
	});

	it("silently ignores a non-numeric limit instead of erroring", () => {
		// Bug/quirk: Number.parseInt("abc") -> NaN, !Number.isFinite -> the
		// branch is skipped entirely, so the default limit survives with no
		// error reported to the user at all.
		const { query, error } = parseSearchQuery("limit: abc");
		expect(error).toBeNull();
		expect(query?.limit).toBe(SEARCH_DEFAULT_LIMIT);
	});

	it("silently ignores a zero or negative limit instead of erroring", () => {
		const { query, error } = parseSearchQuery("limit: 0");
		expect(error).toBeNull();
		expect(query?.limit).toBe(SEARCH_DEFAULT_LIMIT);

		const negative = parseSearchQuery("limit: -5");
		expect(negative.error).toBeNull();
		expect(negative.query?.limit).toBe(SEARCH_DEFAULT_LIMIT);
	});

	it("parses a leading-integer limit via parseInt's partial-string parsing", () => {
		// Bug/quirk: Number.parseInt("10abc", 10) === 10, so trailing garbage
		// after a valid integer prefix is silently accepted.
		const { query, error } = parseSearchQuery("limit: 10abc");
		expect(error).toBeNull();
		expect(query?.limit).toBe(10);
	});

	it.each(["layout", "view"])("accepts %s as table", (key) => {
		const { query, error } = parseSearchQuery(`${key}: table`);
		expect(error).toBeNull();
		expect(query?.layout).toBe("table");
	});

	it("accepts cards as a layout", () => {
		const { query, error } = parseSearchQuery("layout: cards");
		expect(error).toBeNull();
		expect(query?.layout).toBe("cards");
	});

	it('tolerates the singular "card" as an alias for "cards"', () => {
		const { query, error } = parseSearchQuery("layout: card");
		expect(error).toBeNull();
		expect(query?.layout).toBe("cards");
	});

	it("lowercases the layout value before matching", () => {
		const { query, error } = parseSearchQuery("layout: CARDS");
		expect(error).toBeNull();
		expect(query?.layout).toBe("cards");
	});

	it("rejects an unknown layout", () => {
		const { query, error } = parseSearchQuery("layout: grid");
		expect(query).toBeNull();
		expect(error).toBe('Unknown layout "grid" — use table or cards.');
	});

	it("rejects an unknown field", () => {
		const { query, error } = parseSearchQuery("bogus: value");
		expect(query).toBeNull();
		expect(error).toBe('Unknown field "bogus".');
	});

	it('rejects a line with no ":" separator (the shared sep === -1 branch)', () => {
		const { query, error } = parseSearchQuery("not-a-key-value-line");
		expect(query).toBeNull();
		expect(error).toBe('Expected "key: value" lines; got "not-a-key-value-line".');
	});

	it("reports the trimmed line in the sep === -1 error, not the raw line", () => {
		const { query, error } = parseSearchQuery("   bogus line   ");
		expect(query).toBeNull();
		expect(error).toBe('Expected "key: value" lines; got "bogus line".');
	});

	it("rejects a repo that doesn't look like owner/repo", () => {
		const { query, error } = parseSearchQuery("repo: not-a-valid-repo");
		expect(query).toBeNull();
		expect(error).toBe('Invalid repo "not-a-valid-repo" — use owner/repo.');
	});

	it("rejects a repo with a trailing slash segment", () => {
		const { query, error } = parseSearchQuery("repo: a/b/c");
		expect(query).toBeNull();
		expect(error).toBe('Invalid repo "a/b/c" — use owner/repo.');
	});

	it("rejects a repo containing whitespace", () => {
		const { query, error } = parseSearchQuery("repo: a b/c");
		expect(query).toBeNull();
		expect(error).toBe('Invalid repo "a b/c" — use owner/repo.');
	});

	it("is case-insensitive on keys but preserves value case", () => {
		const { query, error } = parseSearchQuery("REPO: Owner/Repo");
		expect(error).toBeNull();
		expect(query?.repo).toBe("Owner/Repo");
	});

	it("combines multiple valid keys into one query", () => {
		const { query, error } = parseSearchQuery(
			[
				"repo: lunerfox/gitea-cards",
				"state: closed",
				"labels: bug, ui",
				"milestone: v1",
				"assignee: lunerfox",
				"q: crash",
				"limit: 3",
				"layout: cards",
			].join("\n")
		);
		expect(error).toBeNull();
		expect(query).toEqual({
			repo: "lunerfox/gitea-cards",
			state: "closed",
			labels: ["bug", "ui"],
			milestones: ["v1"],
			assignee: "lunerfox",
			q: "crash",
			limit: 3,
			layout: "cards",
		});
	});

	it("validates repo only once after the full loop, using the last repo: line", () => {
		const { query, error } = parseSearchQuery(
			"repo: not-valid\nrepo: owner/repo"
		);
		expect(error).toBeNull();
		expect(query?.repo).toBe("owner/repo");
	});
});
