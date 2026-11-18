import { describe, expect, it } from "vitest";
import { buildRepoUrl } from "../src/main";

/**
 * Characterization tests for `buildRepoUrl` (main.ts:683) — pins current
 * behaviour. Same configured-base-URL rule as {@link buildIssueUrl}.
 */
describe("buildRepoUrl", () => {
	it("builds a repo URL from the base URL, owner, and repo", () => {
		expect(buildRepoUrl("http://192.168.1.50:3004", "LS", "obsidian-gitea-cards")).toBe(
			"http://192.168.1.50:3004/LS/obsidian-gitea-cards"
		);
	});

	it("strips trailing slashes from the base URL", () => {
		expect(buildRepoUrl("https://gitea.example.com//", "a", "b")).toBe(
			"https://gitea.example.com/a/b"
		);
	});

	it("honours a subpath-mounted base URL", () => {
		expect(buildRepoUrl("https://host/gitea", "a", "b")).toBe("https://host/gitea/a/b");
	});
});
