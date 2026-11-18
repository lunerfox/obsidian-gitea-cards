import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
	},
	resolve: {
		// Prefer main.ts over any locally built main.js (a gitignored build
		// artifact — absent on a clean checkout, but present after `npm run
		// build` in a local working copy).
		extensions: [".ts", ".mjs", ".js", ".mts", ".json"],
		alias: {
			obsidian: new URL("./tests/mocks/obsidian.ts", import.meta.url)
				.pathname,
		},
	},
});
