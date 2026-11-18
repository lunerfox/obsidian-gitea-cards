import { describe, expect, it } from "vitest";
import { searchQueryKey, type SearchQuery } from "../src/main";

/**
 * Characterization tests for `searchQueryKey` (main.ts:1420) — pins current
 * behaviour. A stable cache key, order-insensitive on the label/milestone
 * lists but order-sensitive on everything else.
 */
describe("searchQueryKey", () => {
	function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
		return {
			repo: null,
			state: "open",
			labels: [],
			milestones: [],
			assignee: null,
			q: null,
			limit: 10,
			layout: "table",
			...overrides,
		};
	}

	it("produces the same key regardless of label order", () => {
		const a = searchQueryKey(query({ labels: ["bug", "ui"] }));
		const b = searchQueryKey(query({ labels: ["ui", "bug"] }));
		expect(a).toBe(b);
	});

	it("produces the same key regardless of milestone order", () => {
		const a = searchQueryKey(query({ milestones: ["v1", "v2"] }));
		const b = searchQueryKey(query({ milestones: ["v2", "v1"] }));
		expect(a).toBe(b);
	});

	it("does not mutate the original labels/milestones arrays", () => {
		const q = query({ labels: ["b", "a"], milestones: ["v2", "v1"] });
		searchQueryKey(q);
		expect(q.labels).toEqual(["b", "a"]);
		expect(q.milestones).toEqual(["v2", "v1"]);
	});

	it("excludes layout from the key — two queries differing only in layout share a key", () => {
		const table = searchQueryKey(query({ layout: "table" }));
		const cards = searchQueryKey(query({ layout: "cards" }));
		expect(table).toBe(cards);
	});

	it("produces different keys for different repo, state, assignee, q, or limit", () => {
		const base = searchQueryKey(query());
		expect(searchQueryKey(query({ repo: "a/b" }))).not.toBe(base);
		expect(searchQueryKey(query({ state: "closed" }))).not.toBe(base);
		expect(searchQueryKey(query({ assignee: "lunerfox" }))).not.toBe(base);
		expect(searchQueryKey(query({ q: "crash" }))).not.toBe(base);
		expect(searchQueryKey(query({ limit: 5 }))).not.toBe(base);
	});
});
