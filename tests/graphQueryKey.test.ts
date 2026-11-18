import { describe, expect, it } from "vitest";
import { graphQueryKey, type GraphQuery } from "../src/main";

/**
 * Characterization tests for `graphQueryKey` (main.ts:1758) — pins current
 * behaviour. Like {@link searchQueryKey} but prefixed `graph!` and
 * deliberately excludes `direction` (layout-only) from the key.
 */
describe("graphQueryKey", () => {
	function query(overrides: Partial<GraphQuery> = {}): GraphQuery {
		return {
			repo: null,
			state: "all",
			labels: [],
			milestones: [],
			q: null,
			limit: 50,
			direction: "TB",
			...overrides,
		};
	}

	it("prefixes the key with graph!", () => {
		expect(graphQueryKey(query())).toMatch(/^graph!/);
	});

	it("produces the same key regardless of label/milestone order", () => {
		const a = graphQueryKey(query({ labels: ["bug", "ui"], milestones: ["v1", "v2"] }));
		const b = graphQueryKey(query({ labels: ["ui", "bug"], milestones: ["v2", "v1"] }));
		expect(a).toBe(b);
	});

	it("excludes direction from the key — two queries differing only in direction share a key", () => {
		const tb = graphQueryKey(query({ direction: "TB" }));
		const lr = graphQueryKey(query({ direction: "LR" }));
		expect(tb).toBe(lr);
	});

	it("produces different keys for different repo, state, q, or limit", () => {
		const base = graphQueryKey(query());
		expect(graphQueryKey(query({ repo: "a/b" }))).not.toBe(base);
		expect(graphQueryKey(query({ state: "open" }))).not.toBe(base);
		expect(graphQueryKey(query({ q: "crash" }))).not.toBe(base);
		expect(graphQueryKey(query({ limit: 5 }))).not.toBe(base);
	});

	it("produces a different key than searchQueryKey would for the equivalent fields (graph! prefix)", () => {
		expect(graphQueryKey(query())).not.toBe(
			JSON.stringify({
				repo: null,
				state: "all",
				labels: [],
				milestones: [],
				q: null,
				limit: 50,
			})
		);
	});
});
