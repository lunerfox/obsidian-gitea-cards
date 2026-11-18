import { describe, expect, it } from "vitest";
import { parseIssueUrl } from "../src/main";

/**
 * Characterization tests for `parseIssueUrl` (main.ts:888) — pins current
 * behaviour. The pasted URL's host must match the *configured* base URL
 * host (never trusting an arbitrary host) so a GitHub issue URL — which
 * shares the `/owner/repo/issues/N` shape — is never mistaken for ours.
 */
describe("parseIssueUrl", () => {
	const base = "http://192.168.1.50:3004";

	it("parses a matching issue URL", () => {
		expect(parseIssueUrl(base, `${base}/LS/obsidian-gitea-cards/issues/73`)).toEqual({
			owner: "LS",
			repo: "obsidian-gitea-cards",
			index: 73,
		});
	});

	it("returns null for a different host", () => {
		expect(parseIssueUrl(base, "https://github.com/owner/repo/issues/1")).toBeNull();
	});

	it("is case-insensitive on the host", () => {
		expect(
			parseIssueUrl("http://HOST.example.com", "http://host.EXAMPLE.com/a/b/issues/1")
		).toEqual({ owner: "a", repo: "b", index: 1 });
	});

	it("tolerates a trailing slash", () => {
		expect(parseIssueUrl(base, `${base}/a/b/issues/1/`)).toEqual({
			owner: "a",
			repo: "b",
			index: 1,
		});
	});

	it("tolerates a query string", () => {
		expect(parseIssueUrl(base, `${base}/a/b/issues/1?foo=bar`)).toEqual({
			owner: "a",
			repo: "b",
			index: 1,
		});
	});

	it("tolerates a comment fragment", () => {
		expect(parseIssueUrl(base, `${base}/a/b/issues/1#issuecomment-42`)).toEqual({
			owner: "a",
			repo: "b",
			index: 1,
		});
	});

	it("honours a subpath-mounted base URL", () => {
		expect(parseIssueUrl("http://host/gitea", "http://host/gitea/a/b/issues/1")).toEqual({
			owner: "a",
			repo: "b",
			index: 1,
		});
	});

	it("rejects an issue path that doesn't sit below the configured subpath", () => {
		expect(parseIssueUrl("http://host/gitea", "http://host/other/a/b/issues/1")).toBeNull();
	});

	it("returns null for a non-issue path on the same host", () => {
		expect(parseIssueUrl(base, `${base}/a/b/pulls/1`)).toBeNull();
	});

	it("returns null for unparsable text", () => {
		expect(parseIssueUrl(base, "not a url")).toBeNull();
	});

	it("returns null for a malformed base URL", () => {
		expect(parseIssueUrl("not a url", `${base}/a/b/issues/1`)).toBeNull();
	});
});
