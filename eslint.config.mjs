// Flat config (ESLint 9+). Requires: eslint-plugin-obsidianmd,
// @typescript-eslint/parser, typescript-eslint.
//
// The obsidianmd recommended set enables some rules with no `files` filter, and
// a few use the TypeScript parser services. Linting JSON/build files with them
// throws "rule requires type information", so we scope ESLint to the TypeScript
// sources and supply parserOptions.project for them.
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{
		ignores: [
			"main.js",
			"esbuild.config.mjs",
			"version-bump.mjs",
			"eslint.config.mjs",
			"**/*.json",
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts", "src/**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
