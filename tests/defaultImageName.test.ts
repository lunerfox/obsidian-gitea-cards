import { describe, expect, it } from "vitest";
import { defaultImageName } from "../src/main";

/**
 * Characterization tests for `defaultImageName` (main.ts:793) — pins current
 * behaviour.
 */
describe("defaultImageName", () => {
	it("derives the extension from the MIME subtype", () => {
		expect(defaultImageName("image/png")).toBe("pasted-image.png");
		expect(defaultImageName("image/jpeg")).toBe("pasted-image.jpeg");
	});

	it("drops MIME parameters after a semicolon", () => {
		expect(defaultImageName("image/png;base64")).toBe("pasted-image.png");
	});

	it("trims whitespace around the subtype", () => {
		expect(defaultImageName("image/ png ")).toBe("pasted-image.png");
	});

	it("falls back to png when the MIME has no subtype", () => {
		expect(defaultImageName("bogus")).toBe("pasted-image.png");
	});

	it("falls back to png for an empty MIME", () => {
		expect(defaultImageName("")).toBe("pasted-image.png");
	});
});
