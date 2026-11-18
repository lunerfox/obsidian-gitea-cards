import { describe, expect, it } from "vitest";
import { isCloudflareBaseUrl } from "../src/main";

/**
 * Characterization tests for `isCloudflareBaseUrl` (main.ts:1089) — pins
 * current behaviour. Treats loopback/private/link-local/CGNAT IPs,
 * `localhost`, and internal-only DNS suffixes as direct (not behind
 * Cloudflare); everything else is assumed to ride the Cloudflare edge.
 */
describe("isCloudflareBaseUrl", () => {
	it.each(["http://localhost:3004", "http://sub.localhost"])(
		"treats %s as direct",
		(url) => {
			expect(isCloudflareBaseUrl(url)).toBe(false);
		}
	);

	it.each([
		"http://0.0.0.1",
		"http://10.0.0.5",
		"http://127.0.0.1",
		"http://192.168.1.50:3004",
		"http://172.16.0.1",
		"http://172.31.255.255",
		"http://169.254.1.1",
		"http://100.64.0.1",
		"http://100.127.255.255",
	])("treats private IPv4 %s as direct", (url) => {
		expect(isCloudflareBaseUrl(url)).toBe(false);
	});

	it.each(["http://172.15.0.1", "http://172.32.0.1", "http://100.63.0.1", "http://100.128.0.1"])(
		"treats %s just outside the private ranges as Cloudflare",
		(url) => {
			expect(isCloudflareBaseUrl(url)).toBe(true);
		}
	);

	it.each([
		"http://host.local",
		"http://host.lan",
		"http://host.internal",
		"http://host.home",
		"http://host.ts.net",
	])("treats internal-only suffix %s as direct", (url) => {
		expect(isCloudflareBaseUrl(url)).toBe(false);
	});

	it("treats IPv6 loopback as direct", () => {
		expect(isCloudflareBaseUrl("http://[::1]")).toBe(false);
	});

	it.each(["http://[fc00::1]", "http://[fd12::1]", "http://[fe80::1]"])(
		"treats IPv6 unique-local/link-local %s as direct",
		(url) => {
			expect(isCloudflareBaseUrl(url)).toBe(false);
		}
	);

	it("treats a public domain as behind Cloudflare", () => {
		expect(isCloudflareBaseUrl("https://gitea.example.com")).toBe(true);
	});

	it("treats a public IP as behind Cloudflare", () => {
		expect(isCloudflareBaseUrl("http://8.8.8.8")).toBe(true);
	});

	it("returns false for a malformed base URL", () => {
		expect(isCloudflareBaseUrl("not a url")).toBe(false);
	});

	it("returns false for an empty-host URL", () => {
		expect(isCloudflareBaseUrl("file:///etc/hosts")).toBe(false);
	});
});
