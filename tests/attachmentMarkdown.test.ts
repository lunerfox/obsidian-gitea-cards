import { describe, expect, it } from "vitest";
import { attachmentMarkdown, type GiteaAttachment } from "../src/main";

/**
 * Characterization tests for `attachmentMarkdown` (main.ts:782) — pins
 * current behaviour.
 */
describe("attachmentMarkdown", () => {
	function att(overrides: Partial<GiteaAttachment> = {}): GiteaAttachment {
		return { uuid: "abc-123", name: "photo.png", browser_download_url: "", ...overrides };
	}

	it("builds an image embed for an image attachment", () => {
		expect(attachmentMarkdown(att())).toBe("![photo.png](/attachments/abc-123)");
	});

	it("builds a plain link for a non-image attachment", () => {
		expect(attachmentMarkdown(att({ name: "log.txt" }))).toBe("[log.txt](/attachments/abc-123)");
	});

	it("strips ] and CR/LF from the filename, replacing each with a space", () => {
		// \r and \n are each replaced individually, so a \r\n pair yields two
		// spaces rather than collapsing to one.
		expect(attachmentMarkdown(att({ name: "weird]name\r\n.png" }))).toBe(
			"![weird name  .png](/attachments/abc-123)"
		);
	});

	it("trims the cleaned filename", () => {
		expect(attachmentMarkdown(att({ name: "  photo.png  " }))).toBe(
			"![photo.png](/attachments/abc-123)"
		);
	});

	it('falls back to "attachment" when the name is empty after cleaning', () => {
		expect(attachmentMarkdown(att({ name: "]\r\n" }))).toBe("[attachment](/attachments/abc-123)");
	});
});
