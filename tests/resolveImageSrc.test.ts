import { describe, expect, it } from "vitest";
import { resolveImageSrc } from "../src/main";

/**
 * Characterization tests for `resolveImageSrc` (main.ts:719) — pins current
 * behaviour. Rewrites Gitea attachment images (host-relative or absolute on
 * Gitea's `ROOT_URL`) onto the configured base host so the authenticated
 * loader can fetch them; leaves foreign images and `data:`/`blob:` URIs
 * alone for a plain `<img>` to load.
 */
describe("resolveImageSrc", () => {
	const base = "http://192.168.1.50:3004";

	it("passes through an empty src unauthenticated", () => {
		expect(resolveImageSrc(base, "")).toEqual({ url: "", authed: false });
	});

	it("passes through a whitespace-only src trimmed", () => {
		expect(resolveImageSrc(base, "   ")).toEqual({ url: "", authed: false });
	});

	it.each(["data:image/png;base64,abc", "blob:http://x/y", "DATA:image/png;base64,abc"])(
		"passes through %s untouched and unauthenticated",
		(src) => {
			expect(resolveImageSrc(base, src)).toEqual({ url: src, authed: false });
		}
	);

	it("resolves a root-relative attachment path against the base host", () => {
		expect(resolveImageSrc(base, "/attachments/abc-123")).toEqual({
			url: `${base}/attachments/abc-123`,
			authed: true,
		});
	});

	it("resolves a path-relative src against the base", () => {
		expect(resolveImageSrc(base, "attachments/abc-123")).toEqual({
			url: `${base}/attachments/abc-123`,
			authed: true,
		});
	});

	it("passes an unresolvable src through unauthenticated when the base URL is malformed", () => {
		expect(resolveImageSrc("not a url", "/attachments/abc")).toEqual({
			url: "/attachments/abc",
			authed: false,
		});
	});

	it("treats an absolute URL already on the base host as authenticated as-is", () => {
		expect(resolveImageSrc(base, `${base}/attachments/abc-123`)).toEqual({
			url: `${base}/attachments/abc-123`,
			authed: true,
		});
	});

	it("is case-insensitive when comparing hosts", () => {
		// The WHATWG URL parser itself lowercases hostnames, so the returned
		// href comes back lowercased regardless of the input's casing.
		expect(resolveImageSrc("http://HOST.example.com", "http://host.EXAMPLE.com/x.png")).toEqual({
			url: "http://host.example.com/x.png",
			authed: true,
		});
	});

	it("rewrites an absolute attachment URL on a foreign host (Gitea's ROOT_URL) onto the base origin", () => {
		expect(
			resolveImageSrc(base, "http://192.168.1.50:3000/attachments/abc-123?x=1")
		).toEqual({
			url: `${base}/attachments/abc-123?x=1`,
			authed: true,
		});
	});

	it("matches the attachment pattern anywhere in the path, not just at the start", () => {
		expect(resolveImageSrc(base, "http://other-host/gitea/attachments/abc-123")).toEqual({
			url: `${base}/gitea/attachments/abc-123`,
			authed: true,
		});
	});

	it("leaves a genuinely foreign non-attachment image untouched and unauthenticated", () => {
		expect(resolveImageSrc(base, "https://cdn.example.com/photo.png")).toEqual({
			url: "https://cdn.example.com/photo.png",
			authed: false,
		});
	});
});
