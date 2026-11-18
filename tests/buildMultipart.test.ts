import { describe, expect, it } from "vitest";
import { buildMultipart } from "../src/main";

/**
 * Characterization tests for `buildMultipart` (main.ts:846) — pins current
 * behaviour. Byte-level assembly of a single-part `multipart/form-data` body
 * by hand (issue #55) — a classic off-by-one site, so these inspect the raw
 * bytes rather than trusting a round-trip parser.
 */
describe("buildMultipart", () => {
	function decode(buf: ArrayBuffer): string {
		return new TextDecoder("utf-8").decode(buf);
	}

	function boundaryOf(contentType: string): string {
		const match = /boundary=(\S+)/.exec(contentType);
		if (!match) {
			throw new Error(`no boundary in ${contentType}`);
		}
		return match[1];
	}

	it("assembles the exact preamble, body, and epilogue bytes for a text file", () => {
		const bytes = new TextEncoder().encode("hello").buffer;
		const { body, contentType } = buildMultipart("file", "photo.png", "image/png", bytes);
		const boundary = boundaryOf(contentType);
		expect(decode(body)).toBe(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="file"; filename="photo.png"\r\n` +
				`Content-Type: image/png\r\n\r\n` +
				`hello` +
				`\r\n--${boundary}--\r\n`
		);
	});

	it("sets contentType's boundary to match the one embedded in the body", () => {
		const { body, contentType } = buildMultipart("file", "a.png", "image/png", new ArrayBuffer(0));
		const boundary = boundaryOf(contentType);
		const text = decode(body);
		expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
		expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
		expect(contentType).toBe(`multipart/form-data; boundary=${boundary}`);
	});

	it("handles an empty file with no bytes between the headers and the closing boundary", () => {
		const { body, contentType } = buildMultipart(
			"file",
			"empty.png",
			"image/png",
			new ArrayBuffer(0)
		);
		const boundary = boundaryOf(contentType);
		expect(decode(body)).toBe(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="file"; filename="empty.png"\r\n` +
				`Content-Type: image/png\r\n\r\n` +
				`\r\n--${boundary}--\r\n`
		);
	});

	it("embeds raw non-UTF8 file bytes verbatim between the headers and the closing boundary", () => {
		const raw = new Uint8Array([0x00, 0xff, 0x10, 0x89, 0x50, 0x4e, 0x47]);
		const { body } = buildMultipart("file", "img.png", "image/png", raw.buffer);
		const out = new Uint8Array(body);
		// Headers end at the first blank line (\r\n\r\n); the epilogue starts
		// with \r\n--boundary--\r\n immediately after the file bytes.
		const headerEnd = indexOfSubarray(out, encode("\r\n\r\n")) + 4;
		const fileBytes = out.slice(headerEnd, headerEnd + raw.length);
		expect(Array.from(fileBytes)).toEqual(Array.from(raw));
	});

	it('sanitizes CR, LF, and " out of the filename, replacing each with "_"', () => {
		const { body } = buildMultipart(
			"file",
			'evil"\r\nname.png',
			"image/png",
			new ArrayBuffer(0)
		);
		const text = decode(body);
		expect(text).toContain('filename="evil___name.png"');
	});

	it("does not sanitize the fieldName or mime, and does not escape quotes already removed", () => {
		const { body } = buildMultipart("my field", "a.png", "image/png; charset=binary", new ArrayBuffer(0));
		const text = decode(body);
		expect(text).toContain('name="my field"');
		expect(text).toContain("Content-Type: image/png; charset=binary\r\n\r\n");
	});

	it("produces a distinct boundary on every call", () => {
		const a = buildMultipart("file", "a.png", "image/png", new ArrayBuffer(0));
		const b = buildMultipart("file", "b.png", "image/png", new ArrayBuffer(0));
		expect(boundaryOf(a.contentType)).not.toBe(boundaryOf(b.contentType));
	});

	function encode(s: string): Uint8Array {
		return new TextEncoder().encode(s);
	}

	function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
		outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
			for (let j = 0; j < needle.length; j++) {
				if (haystack[i + j] !== needle[j]) {
					continue outer;
				}
			}
			return i;
		}
		return -1;
	}
});
