import { describe, expect, it } from "vitest";
import {
	GRAPH_DIRECTIONS,
	SEARCH_MAX_LIMIT,
	parseGraphQuery,
} from "../src/main";

/**
 * Characterization tests for `parseGraphQuery` (main.ts:1665) — pins current
 * behaviour, bugs included, as a baseline for later refactors. Shares most of
 * its field vocabulary (and its parsing loop, byte-for-byte) with
 * `parseSearchQuery`, but defaults to `state: all` / the max limit, has no
 * `assignee` or `layout` field, and adds `direction`.
 */
describe("parseGraphQuery", () => {
	it("defaults an empty body to a global all-state graph at the max limit", () => {
		const { query, error } = parseGraphQuery("");
		expect(error).toBeNull();
		expect(query).toEqual({
			repo: null,
			state: "all",
			labels: [],
			milestones: [],
			q: null,
			limit: SEARCH_MAX_LIMIT,
			direction: "TB",
		});
	});

	it("skips blank lines", () => {
		const { query, error } = parseGraphQuery("\n  \nrepo: a/b\n\n");
		expect(error).toBeNull();
		expect(query?.repo).toBe("a/b");
	});

	it("parses repo as owner/repo", () => {
		const { query, error } = parseGraphQuery("repo: lunerfox/gitea-cards");
		expect(error).toBeNull();
		expect(query?.repo).toBe("lunerfox/gitea-cards");
	});

	it("treats an empty repo value as null rather than an empty string", () => {
		const { query, error } = parseGraphQuery("repo:");
		expect(error).toBeNull();
		expect(query?.repo).toBeNull();
	});

	it.each(["open", "closed", "all"])("accepts state %s", (state) => {
		const { query, error } = parseGraphQuery(`state: ${state}`);
		expect(error).toBeNull();
		expect(query?.state).toBe(state);
	});

	it("lowercases state", () => {
		const { query, error } = parseGraphQuery("state: OPEN");
		expect(error).toBeNull();
		expect(query?.state).toBe("open");
	});

	it("rejects an unknown state", () => {
		const { query, error } = parseGraphQuery("state: bogus");
		expect(query).toBeNull();
		expect(error).toBe('Unknown state "bogus" — use open, closed, or all.');
	});

	it.each(["label", "labels"])(
		"splits %s into a trimmed, non-empty list",
		(key) => {
			const { query, error } = parseGraphQuery(`${key}: bug, ui ,  ,`);
			expect(error).toBeNull();
			expect(query?.labels).toEqual(["bug", "ui"]);
		}
	);

	it.each(["milestone", "milestones"])(
		"splits %s into a trimmed, non-empty list",
		(key) => {
			const { query, error } = parseGraphQuery(`${key}: v1, v2`);
			expect(error).toBeNull();
			expect(query?.milestones).toEqual(["v1", "v2"]);
		}
	);

	it.each(["q", "query"])("accepts %s as the free-text filter", (key) => {
		const { query, error } = parseGraphQuery(`${key}: inline chip bug`);
		expect(error).toBeNull();
		expect(query?.q).toBe("inline chip bug");
	});

	it("has no assignee field — unlike parseSearchQuery", () => {
		const { query, error } = parseGraphQuery("assignee: lunerfox");
		expect(query).toBeNull();
		expect(error).toBe('Unknown field "assignee".');
	});

	it("has no layout field — unlike parseSearchQuery", () => {
		const { query, error } = parseGraphQuery("layout: cards");
		expect(query).toBeNull();
		expect(error).toBe('Unknown field "layout".');
	});

	it("parses a valid limit, capped at SEARCH_MAX_LIMIT", () => {
		const { query, error } = parseGraphQuery(`limit: ${SEARCH_MAX_LIMIT + 50}`);
		expect(error).toBeNull();
		expect(query?.limit).toBe(SEARCH_MAX_LIMIT);
	});

	it("silently ignores a non-numeric limit instead of erroring", () => {
		const { query, error } = parseGraphQuery("limit: abc");
		expect(error).toBeNull();
		expect(query?.limit).toBe(SEARCH_MAX_LIMIT);
	});

	it("silently ignores a zero or negative limit instead of erroring", () => {
		const { query, error } = parseGraphQuery("limit: 0");
		expect(error).toBeNull();
		expect(query?.limit).toBe(SEARCH_MAX_LIMIT);
	});

	it.each(GRAPH_DIRECTIONS)("accepts direction %s", (direction) => {
		const { query, error } = parseGraphQuery(`direction: ${direction}`);
		expect(error).toBeNull();
		expect(query?.direction).toBe(direction);
	});

	it.each(["direction", "dir"])("accepts %s as an alias", (key) => {
		const { query, error } = parseGraphQuery(`${key}: LR`);
		expect(error).toBeNull();
		expect(query?.direction).toBe("LR");
	});

	it('tolerates Mermaid\'s "TD" as an alias for top-to-bottom', () => {
		const { query, error } = parseGraphQuery("direction: TD");
		expect(error).toBeNull();
		expect(query?.direction).toBe("TB");
	});

	it("uppercases the direction value before matching", () => {
		const { query, error } = parseGraphQuery("direction: lr");
		expect(error).toBeNull();
		expect(query?.direction).toBe("LR");
	});

	it("rejects an unknown direction", () => {
		const { query, error } = parseGraphQuery("direction: diagonal");
		expect(query).toBeNull();
		expect(error).toBe('Unknown direction "diagonal" — use TB or LR.');
	});

	it("rejects an unknown field", () => {
		const { query, error } = parseGraphQuery("bogus: value");
		expect(query).toBeNull();
		expect(error).toBe('Unknown field "bogus".');
	});

	it('rejects a line with no ":" separator (the shared sep === -1 branch)', () => {
		const { query, error } = parseGraphQuery("not-a-key-value-line");
		expect(query).toBeNull();
		expect(error).toBe('Expected "key: value" lines; got "not-a-key-value-line".');
	});

	it("rejects a repo that doesn't look like owner/repo", () => {
		const { query, error } = parseGraphQuery("repo: not-a-valid-repo");
		expect(query).toBeNull();
		expect(error).toBe('Invalid repo "not-a-valid-repo" — use owner/repo.');
	});

	it("combines multiple valid keys into one query", () => {
		const { query, error } = parseGraphQuery(
			[
				"repo: lunerfox/gitea-cards",
				"state: closed",
				"labels: bug, ui",
				"milestone: v1",
				"q: crash",
				"limit: 3",
				"direction: LR",
			].join("\n")
		);
		expect(error).toBeNull();
		expect(query).toEqual({
			repo: "lunerfox/gitea-cards",
			state: "closed",
			labels: ["bug", "ui"],
			milestones: ["v1"],
			q: "crash",
			limit: 3,
			direction: "LR",
		});
	});
});
