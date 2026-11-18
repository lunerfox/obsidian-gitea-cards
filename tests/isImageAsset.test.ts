import { describe, expect, it } from "vitest";
import { isImageAsset } from "../src/main";

/**
 * Characterization tests for `isImageAsset` (main.ts:770) — pins current
 * behaviour. Detection is by filename extension only (issue #54).
 */
describe("isImageAsset", () => {
	it.each([
		"photo.png",
		"photo.jpg",
		"photo.jpeg",
		"photo.gif",
		"photo.webp",
		"photo.svg",
		"photo.bmp",
		"photo.avif",
		"photo.ico",
		"photo.tiff",
		"photo.tif",
	])("treats %s as an image", (name) => {
		expect(isImageAsset(name)).toBe(true);
	});

	it("is case-insensitive on the extension", () => {
		expect(isImageAsset("PHOTO.PNG")).toBe(true);
	});

	it("trims whitespace before matching", () => {
		expect(isImageAsset("  photo.png  ")).toBe(true);
	});

	it("rejects a non-image extension", () => {
		expect(isImageAsset("log.txt")).toBe(false);
		expect(isImageAsset("archive.zip")).toBe(false);
		expect(isImageAsset("report.pdf")).toBe(false);
	});

	it("rejects a filename with no extension", () => {
		expect(isImageAsset("README")).toBe(false);
	});
});
