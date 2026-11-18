import { describe, expect, it } from "vitest";
import { buildIssueUrl } from "../src/main";

/**
 * Characterization tests for `buildIssueUrl` (main.ts:673) — pins current
 * behaviour. The issue link is built from the *configured* base URL, never
 * the API's `html_url` (whose host is Gitea's `ROOT_URL`, often a LAN
 * address behind Cloudflare).
 */
describe("buildIssueUrl", () => {
	it("builds an issue URL from the base URL and ref", () => {
		expect(
			buildIssueUrl("http://192.168.1.50:3004", {
				owner: "LS",
				repo: "obsidian-gitea-cards",
				index: 73,
			})
		).toBe("http://192.168.1.50:3004/LS/obsidian-gitea-cards/issues/73");
	});

	it("strips one or more trailing slashes from the base URL", () => {
		expect(
			buildIssueUrl("https://gitea.example.com/", { owner: "a", repo: "b", index: 1 })
		).toBe("https://gitea.example.com/a/b/issues/1");
		expect(
			buildIssueUrl("https://gitea.example.com///", { owner: "a", repo: "b", index: 1 })
		).toBe("https://gitea.example.com/a/b/issues/1");
	});

	it("honours a subpath-mounted base URL", () => {
		expect(buildIssueUrl("https://host/gitea", { owner: "a", repo: "b", index: 2 })).toBe(
			"https://host/gitea/a/b/issues/2"
		);
	});

	it("does not encode or validate owner/repo — interpolates them verbatim", () => {
		expect(
			buildIssueUrl("https://host", { owner: "a b", repo: "c", index: 1 })
		).toBe("https://host/a b/c/issues/1");
	});
});
