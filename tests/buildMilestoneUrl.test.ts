import { describe, expect, it } from "vitest";
import { buildMilestoneUrl } from "../src/main";

/**
 * Characterization tests for `buildMilestoneUrl` (main.ts:1576) — pins
 * current behaviour. Same configured-base-URL rule as {@link buildIssueUrl}:
 * `repo` here is the already-combined `owner/repo` slug, not split further.
 */
describe("buildMilestoneUrl", () => {
	it("builds a milestone URL from the base URL, repo, and milestone id", () => {
		expect(buildMilestoneUrl("http://192.168.1.50:3004", "LS/obsidian-gitea-cards", 7)).toBe(
			"http://192.168.1.50:3004/LS/obsidian-gitea-cards/milestone/7"
		);
	});

	it("strips trailing slashes from the base URL", () => {
		expect(buildMilestoneUrl("https://gitea.example.com/", "a/b", 1)).toBe(
			"https://gitea.example.com/a/b/milestone/1"
		);
	});

	it("honours a subpath-mounted base URL", () => {
		expect(buildMilestoneUrl("https://host/gitea", "a/b", 3)).toBe(
			"https://host/gitea/a/b/milestone/3"
		);
	});
});
