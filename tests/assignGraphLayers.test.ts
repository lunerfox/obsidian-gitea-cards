import { describe, expect, it } from "vitest";
import { assignGraphLayers } from "../src/main";

/**
 * Characterization tests for `assignGraphLayers` (main.ts:1861) — pins
 * current behaviour. Layer = longest path from a root (max(layer of
 * blockers) + 1, 0 for roots); a visiting-set guard breaks a cycle at layer
 * 0 for whichever node is reached first in the traversal.
 */
describe("assignGraphLayers", () => {
	it("gives every node layer 0 when there are no edges", () => {
		const layers = assignGraphLayers([{ id: "A" }, { id: "B" }], []);
		expect(layers.get("A")).toBe(0);
		expect(layers.get("B")).toBe(0);
	});

	it("stacks a linear chain one layer per blocker", () => {
		const layers = assignGraphLayers(
			[{ id: "A" }, { id: "B" }, { id: "C" }],
			[
				{ from: "A", to: "B" },
				{ from: "B", to: "C" },
			]
		);
		expect(layers.get("A")).toBe(0);
		expect(layers.get("B")).toBe(1);
		expect(layers.get("C")).toBe(2);
	});

	it("takes the max over multiple blockers (diamond shape)", () => {
		const layers = assignGraphLayers(
			[{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
			[
				{ from: "A", to: "B" },
				{ from: "A", to: "C" },
				{ from: "B", to: "D" },
				{ from: "C", to: "D" },
			]
		);
		expect(layers.get("A")).toBe(0);
		expect(layers.get("B")).toBe(1);
		expect(layers.get("C")).toBe(1);
		expect(layers.get("D")).toBe(2);
	});

	it("ignores an edge referencing a node outside the set", () => {
		const layers = assignGraphLayers(
			[{ id: "A" }, { id: "B" }],
			[
				{ from: "X", to: "B" },
				{ from: "A", to: "B" },
			]
		);
		expect(layers.get("A")).toBe(0);
		expect(layers.get("B")).toBe(1);
	});

	it("breaks a two-node cycle at the first-visited node — result depends on node order", () => {
		// Quirk: the visiting-set cycle guard returns 0 for whichever node the
		// traversal reaches *second*, so the two layers end up asymmetric and
		// depend on the input node order rather than being symmetric.
		const edges = [
			{ from: "A", to: "B" },
			{ from: "B", to: "A" },
		];
		const ab = assignGraphLayers([{ id: "A" }, { id: "B" }], edges);
		expect(ab.get("A")).toBe(2);
		expect(ab.get("B")).toBe(1);

		const ba = assignGraphLayers([{ id: "B" }, { id: "A" }], edges);
		expect(ba.get("A")).toBe(1);
		expect(ba.get("B")).toBe(2);
	});
});
