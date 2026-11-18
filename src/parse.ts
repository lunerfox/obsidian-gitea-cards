import { Editor, RequestUrlResponse } from "obsidian";
import { GiteaAttachment, GiteaIssue, GiteaListIssue, IssueInsertFormat, IssueRef } from "./types";

/**
 * Whether an element is currently shown — used to skip refreshing cards whose
 * note has scrolled off-screen or sits in a background leaf. Obsidian augments
 * HTMLElement with `isShown()`; fall back to layout checks where it is absent.
 */
export function isElementVisible(el: HTMLElement): boolean {
	if (!el.isConnected) {
		return false;
	}
	const augmented = el as HTMLElement & { isShown?: () => boolean };
	if (typeof augmented.isShown === "function") {
		return augmented.isShown();
	}
	return el.offsetParent !== null;
}

/**
 * Whether `el` is being rendered inside Obsidian's Export-to-PDF pass rather
 * than the live preview. Export re-renders the whole note into a temporary
 * `div.print` appended directly under `document.body`, then snapshots it
 * synchronously (Electron `printToPDF`); live preview and reading view render
 * inside a workspace leaf and never sit under `.print`. `closest` is a plain DOM
 * read — no Obsidian-internal API — so this is the seam that lets a card await
 * full hydration only when it is being exported (issue #66).
 */
export function isExportingToPdf(el: HTMLElement): boolean {
	return el.closest(".print") !== null;
}

export const ISSUE_REF_PATTERN = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;

/**
 * Parse a single `owner/repo#index` reference. Returns null when the source is
 * empty, multi-line, or otherwise malformed so the caller can show guidance.
 */
export function parseIssueRef(source: string): IssueRef | null {
	const match = ISSUE_REF_PATTERN.exec(source.trim());
	if (!match) {
		return null;
	}
	return {
		owner: match[1],
		repo: match[2],
		index: Number.parseInt(match[3], 10),
	};
}

/** Hard cap on the number of recent comments a thread preview shows (issue #40). */
export const COMMENTS_MAX_PREVIEW = 20;

/**
 * A parsed `gitea-issue` block: the issue reference plus an optional comment
 * thread auto-expansion (issue #40). `comments` is null when the block carries
 * no `comments:` key (the thread stays collapsed); 0 means "auto-expand using the
 * configured default count"; a positive number overrides that count.
 */
export interface IssueBlock {
	ref: IssueRef;
	comments: number | null;
}

/**
 * Parse a `gitea-issue` block body into an {@link IssueBlock}: the first line is
 * an `owner/repo#index` reference, with optional `key: value` lines below it
 * (currently just `comments: N`, which auto-expands the thread — issue #40).
 * Returns an error string instead of a block for malformed input so the block can
 * show one line of guidance. A bare reference with no extra lines is valid (the
 * common case) and leaves the thread collapsed.
 */
export function parseIssueBlock(source: string): {
	block: IssueBlock | null;
	error: string | null;
} {
	let ref: IssueRef | null = null;
	let comments: number | null = null;

	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		const maybeRef = parseIssueRef(line);
		if (maybeRef) {
			ref = maybeRef;
			continue;
		}
		const sep = line.indexOf(":");
		if (sep === -1) {
			return {
				block: null,
				error: `Expected owner/repo#index or "key: value"; got "${line}".`,
			};
		}
		const key = line.slice(0, sep).trim().toLowerCase();
		const value = line.slice(sep + 1).trim();
		switch (key) {
			case "comments": {
				const parsed = Number.parseInt(value, 10);
				// A positive count both auto-expands and sets how many to show; an
				// empty/zero/invalid value auto-expands with the configured default.
				comments =
					Number.isFinite(parsed) && parsed > 0
						? Math.min(parsed, COMMENTS_MAX_PREVIEW)
						: 0;
				break;
			}
			default:
				return { block: null, error: `Unknown field "${key}".` };
		}
	}

	if (!ref) {
		return {
			block: null,
			error: "Expected a single reference in owner/repo#index form.",
		};
	}
	return { block: { ref, comments }, error: null };
}

/**
 * Build the issue link from the configured base URL — never the API's
 * `html_url`, whose host is Gitea's `ROOT_URL` (the LAN IP). See ROOT_URL caveat.
 */
export function buildIssueUrl(baseUrl: string, ref: IssueRef): string {
	const base = baseUrl.replace(/\/+$/, "");
	return `${base}/${ref.owner}/${ref.repo}/issues/${ref.index}`;
}

/**
 * Build the repo link from the configured base URL — `/{owner}/{repo}`. Same
 * `ROOT_URL` caveat as {@link buildIssueUrl}: never derive the host from the
 * API's `html_url`.
 */
export function buildRepoUrl(baseUrl: string, owner: string, repo: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return `${base}/${owner}/${repo}`;
}

/** Whether a URL path carries a Gitea attachment segment (`/attachments/<uuid>`). */
export const ATTACHMENT_PATH_PATTERN = /\/attachments\/[^/]+/i;

/**
 * Resolution of an `<img src>` found in issue/comment markdown into a fetchable
 * URL plus whether it must ride our authenticated loader.
 */
export interface ResolvedImageSrc {
	/** The absolute URL to load (rewritten onto the configured host when ours). */
	url: string;
	/**
	 * True when the URL points at our Gitea and must be fetched through {@link
	 * GiteaCardsPlugin.loadAuthedImage} (an `<img src>` can't carry the auth
	 * headers); false for `data:` URIs and foreign images a plain `<img>` loads.
	 */
	authed: boolean;
}

/**
 * Resolve an `<img src>` from rendered Gitea markdown against the configured
 * base URL, deciding whether it needs our authenticated loader.
 *
 * Gitea writes attachment images as host-relative `/attachments/<uuid>` (or, in
 * older markdown, an absolute link on its `ROOT_URL` — often a LAN IP even when
 * we reach Gitea through a Cloudflare base host). Both must be fetched with the
 * PAT (+ `CF-Access-*`) headers, so they are rewritten onto the configured base
 * and flagged `authed`. Same `ROOT_URL` caveat the issue links honour: trust the
 * configured base host, never the one Gitea emits. Relative srcs resolve against
 * the base (honouring a subpath mount). Foreign `https://…` images and `data:`/
 * `blob:` URIs are left untouched for a plain `<img>` to load directly.
 */
export function resolveImageSrc(baseUrl: string, src: string): ResolvedImageSrc {
	const trimmed = src.trim();
	if (!trimmed || /^(data|blob):/i.test(trimmed)) {
		return { url: trimmed, authed: false };
	}
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		return { url: trimmed, authed: false };
	}
	let abs: URL | null = null;
	try {
		abs = new URL(trimmed);
	} catch {
		abs = null;
	}
	// Relative src — resolve against the configured base (honours a subpath mount).
	if (!abs) {
		try {
			const root = baseUrl.replace(/\/+$/, "") + "/";
			return { url: new URL(trimmed, root).href, authed: true };
		} catch {
			return { url: trimmed, authed: false };
		}
	}
	// Absolute and already on our host — load it through the token as-is.
	if (abs.host.toLowerCase() === base.host.toLowerCase()) {
		return { url: abs.href, authed: true };
	}
	// Absolute attachment on a different host (Gitea's ROOT_URL) — rewrite the
	// path onto the configured base host/scheme so the token reaches it.
	if (ATTACHMENT_PATH_PATTERN.test(abs.pathname)) {
		const rewritten = new URL(base.origin);
		rewritten.pathname = abs.pathname;
		rewritten.search = abs.search;
		return { url: rewritten.href, authed: true };
	}
	// A genuinely foreign image — let a plain `<img src>` load it unauthenticated.
	return { url: trimmed, authed: false };
}

/** File extensions the attachment strip renders as an inline thumbnail (issue #54). */
export const IMAGE_ASSET_PATTERN = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i;

/**
 * Whether an attachment's filename names an image type the strip can thumbnail
 * (issue #54). Detection is by extension — Gitea's assets endpoint reports a
 * `name` but no MIME — so non-image uploads (logs, zips, PDFs) fall through to a
 * `📎 filename` download chip instead.
 */
export function isImageAsset(name: string): boolean {
	return IMAGE_ASSET_PATTERN.test(name.trim());
}

/**
 * Markdown for an uploaded attachment to splice into an issue/comment body (issue
 * #56). Gitea serves attachments at the root-relative `/attachments/{uuid}` path,
 * which I2's comment-image pass rewrites onto the configured base before fetching —
 * so the inserted link matches exactly what the Gitea web UI writes. Images get the
 * `![…]` embed form; anything else a plain `[…]` link. The label is the stored
 * filename with `]`/CR/LF stripped so it can't break out of the link text.
 */
export function attachmentMarkdown(att: GiteaAttachment): string {
	const label = att.name.replace(/[\r\n\]]/g, " ").trim() || "attachment";
	const link = `/attachments/${att.uuid}`;
	return isImageAsset(att.name) ? `![${label}](${link})` : `[${label}](${link})`;
}

/**
 * A filename for an image that arrives without one — a clipboard paste yields a
 * `File` with an empty `name` (issue #56). Derives the extension from the MIME
 * subtype (`image/png` → `pasted-image.png`), falling back to `png`.
 */
export function defaultImageName(mime: string): string {
	const subtype = mime.split("/")[1]?.split(";")[0]?.trim() || "png";
	return `pasted-image.${subtype}`;
}

/**
 * Splice text into a textarea at the caret, putting it on its own line (issue #56).
 * The attachment markdown lands where the user was typing, padded with a leading
 * newline when it would otherwise share a line with existing text and a trailing
 * one so the next keystroke starts fresh, and the caret is left after the insert.
 */
export function insertAtCursor(input: HTMLTextAreaElement, text: string): void {
	const start = input.selectionStart ?? input.value.length;
	const end = input.selectionEnd ?? input.value.length;
	const before = input.value.slice(0, start);
	const after = input.value.slice(end);
	const lead = before && !before.endsWith("\n") ? "\n" : "";
	const insert = `${lead}${text}\n`;
	input.value = `${before}${insert}${after}`;
	const caret = before.length + insert.length;
	input.setSelectionRange(caret, caret);
}

/**
 * Monotonic counter feeding each {@link buildMultipart} call a distinct boundary,
 * so two uploads in one session never reuse a boundary token (mirrors {@link
 * graphRenderSeq}'s role for marker ids).
 */
export let multipartBoundarySeq = 0;

/** A hand-built multipart/form-data body plus its matching `Content-Type`. */
export interface MultipartBody {
	/** The encoded request body, ready to hand to `requestUrl`. */
	body: ArrayBuffer;
	/** `multipart/form-data; boundary=…`, to set as the request's content type. */
	contentType: string;
}

/**
 * Build a single-part `multipart/form-data` body by hand (issue #55). The plugin
 * has only ever sent JSON bodies, and Obsidian's `requestUrl` has no `FormData`
 * (and no mobile-safe `Blob`-as-body path), so the multipart envelope is assembled
 * as raw bytes: a UTF-8 preamble (the boundary + `Content-Disposition` naming the
 * field and filename), the file bytes verbatim, then the closing boundary.
 *
 * The filename rides in `Content-Disposition` rather than a `?name=` query param,
 * which is buggy in some Gitea versions (go-gitea#30766). CR/LF and `"` are stripped
 * from the filename first so a picked file's name can't inject extra headers or
 * break the envelope. The boundary carries a per-call token (counter-based) so it
 * cannot collide with a previous upload; the `----GiteaCards` prefix keeps it from
 * appearing in real file bytes. Uses only the web-standard `TextEncoder`/typed
 * arrays, so it runs on mobile.
 */
export function buildMultipart(
	fieldName: string,
	filename: string,
	mime: string,
	bytes: ArrayBuffer
): MultipartBody {
	const boundary = `----GiteaCards${(multipartBoundarySeq++).toString(36)}${Date.now().toString(
		36
	)}`;
	const safeName = filename.replace(/[\r\n"]/g, "_");
	const encoder = new TextEncoder();
	const preamble = encoder.encode(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n` +
			`Content-Type: ${mime}\r\n\r\n`
	);
	const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);
	const fileBytes = new Uint8Array(bytes);
	const body = new Uint8Array(
		preamble.length + fileBytes.length + epilogue.length
	);
	body.set(preamble, 0);
	body.set(fileBytes, preamble.length);
	body.set(epilogue, preamble.length + fileBytes.length);
	return {
		body: body.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

/** The issue path of a Gitea URL — `/{owner}/{repo}/issues/{index}`. */
export const ISSUE_URL_PATH_PATTERN = /^\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/;

/**
 * Parse a pasted Gitea issue URL into an {@link IssueRef}, or null when the text
 * is not a single issue URL on the configured host. The host must match the base
 * URL so the paste handler never hijacks an unrelated link — a GitHub issue URL
 * shares the `/owner/repo/issues/N` shape. A base URL mounted on a subpath (e.g.
 * `https://host/gitea`) is honoured: the issue path sits below it, so the prefix
 * is stripped before matching. Trailing slashes and any `?query`/`#fragment`
 * (Gitea appends `#issuecomment-…` when you copy a comment link) are tolerated.
 */
export function parseIssueUrl(baseUrl: string, text: string): IssueRef | null {
	let url: URL;
	let base: URL;
	try {
		url = new URL(text.trim());
		base = new URL(baseUrl);
	} catch {
		return null;
	}
	if (url.host.toLowerCase() !== base.host.toLowerCase()) {
		return null;
	}
	const basePath = base.pathname.replace(/\/+$/, "");
	if (basePath && !url.pathname.startsWith(`${basePath}/`)) {
		return null;
	}
	const match = ISSUE_URL_PATH_PATTERN.exec(url.pathname.slice(basePath.length));
	if (!match) {
		return null;
	}
	return {
		owner: match[1],
		repo: match[2],
		index: Number.parseInt(match[3], 10),
	};
}

/**
 * Anchored pattern matching the *entire* text of an inline-code span that is a
 * single completed reference — `GITEA:owner/repo:#123` (keyword configurable).
 * A chip only renders from a backtick-wrapped reference (an inline-code span),
 * never from bare prose, so an unadorned `GITEA:owner/repo:#123` in running text
 * is left untouched (issue #14). Used by the reading-view post-processor, which
 * matches it against the trimmed text content of each `<code>` element. A fresh
 * instance per call tracks the current keyword.
 */
export function inlineChipReferencePattern(keyword: string): RegExp {
	return new RegExp(
		`^${escapeRegExp(keyword)}:([^\\s:/]+)/([^\\s:/]+):#(\\d+)$`
	);
}

/**
 * The global-flagged pattern for a backtick-wrapped reference,
 * `` `GITEA:owner/repo:#123` `` (keyword configurable), used to locate chips in
 * the Live Preview source — where the backticks are still part of the document
 * text. The backticks are part of the match, so the widget replaces them along
 * with the reference. A fresh instance per call so each gets its own `lastIndex`
 * and tracks the current keyword.
 */
export function inlineChipSourcePattern(keyword: string): RegExp {
	return new RegExp(
		"`" + escapeRegExp(keyword) + ":([^\\s:/`]+)/([^\\s:/`]+):#(\\d+)`",
		"g"
	);
}

/**
 * Build the inline-chip anchor (`● #123`), before any issue data has loaded.
 * The state dot is colourless and the title/state slots are empty (so the chip
 * shows just `● #123`) until {@link applyChipState} fills them in. Shared by
 * both the reading-view chip and the editor-view widget so they render
 * identically.
 *
 * When the chip's repo has a configured accent colour (issue #30), it gets the
 * same subtle coloured left border the full cards use — fed to the static CSS
 * rule via a `--gitea-accent` custom property, so inline references are tinted
 * in step with their cards.
 */
export function createChipElement(
	baseUrl: string,
	ref: IssueRef,
	accent?: string
): HTMLAnchorElement {
	const chip = createEl("a", {
		cls: "gitea-chip",
		href: buildIssueUrl(baseUrl, ref),
	});
	chip.setAttr("target", "_blank");
	chip.setAttr("rel", "noopener");
	chip.setAttr("aria-label", `${ref.owner}/${ref.repo}#${ref.index}`);
	if (accent) {
		chip.addClass("gitea-chip--accented");
		chip.style.setProperty("--gitea-accent", accent);
	}
	chip.createSpan({ cls: "gitea-chip__dot" });
	chip.createSpan({ cls: "gitea-chip__number", text: `#${ref.index}` });
	// Title and state stay empty (hidden via CSS) until the issue loads.
	chip.createSpan({ cls: "gitea-chip__title" });
	chip.createSpan({ cls: "gitea-chip__state" });
	return chip;
}

/**
 * Whether an open issue carries the configured "in progress" label (issue #26).
 * The match is case-insensitive on the trimmed name; an empty configured label
 * disables the feature so no issue is ever treated as in progress.
 */
export function isInProgress(issue: GiteaIssue, inProgressLabel: string): boolean {
	const target = inProgressLabel.trim().toLowerCase();
	if (!target) {
		return false;
	}
	return issue.labels.some(
		(label) => label.name.trim().toLowerCase() === target
	);
}

/**
 * Whether a list/search issue is assigned to the given login (issue #62). The
 * match is case-insensitive on the trimmed login; `assignee` is expected already
 * lower-cased by the caller. Used to filter global-search results, which the
 * Gitea endpoint can't narrow by assignee server-side.
 */
export function issueHasAssignee(issue: GiteaListIssue, assignee: string): boolean {
	return (issue.assignees ?? []).some(
		(user) => user.login.trim().toLowerCase() === assignee
	);
}

/**
 * Fill an inline chip with the loaded issue's details: colour the state dot,
 * show the title, and add an open/closed/in-progress status badge — turning the
 * bare `● #123` placeholder into `● #123 Issue title OPEN`. An open issue that
 * carries the configured in-progress label (issue #26) gets an amber dot and an
 * "in progress" badge instead. Idempotent, so a refresh re-applying the same
 * issue is harmless.
 */
export function applyChipState(
	chip: HTMLElement,
	issue: GiteaIssue,
	inProgressLabel: string
): void {
	chip.setAttr("aria-label", `#${issue.number} — ${issue.title}`);
	const isClosed = issue.state === "closed";
	const inProgress = !isClosed && isInProgress(issue, inProgressLabel);
	chip.toggleClass("gitea-chip--closed", isClosed);
	const status = isClosed ? "closed" : inProgress ? "in-progress" : "open";
	const label = inProgress ? "in progress" : status;
	const dot = chip.querySelector<HTMLElement>(".gitea-chip__dot");
	if (dot) {
		dot.removeClass(
			"gitea-chip__dot--open",
			"gitea-chip__dot--closed",
			"gitea-chip__dot--in-progress"
		);
		dot.addClass(`gitea-chip__dot--${status}`);
	}
	chip.querySelector<HTMLElement>(".gitea-chip__title")?.setText(issue.title);
	const state = chip.querySelector<HTMLElement>(".gitea-chip__state");
	if (state) {
		state.removeClass(
			"gitea-chip__state--open",
			"gitea-chip__state--closed",
			"gitea-chip__state--in-progress"
		);
		state.addClass(`gitea-chip__state--${status}`);
		state.setText(label);
	}
}

/**
 * Whether an IPv4 literal sits in a private, loopback, link-local, or CGNAT
 * range — i.e. an address only reachable on the LAN or over Tailscale, never
 * through the public Cloudflare edge. The CGNAT block (100.64.0.0/10) is what
 * Tailscale hands out, so a tailnet IP reads as private here too.
 */
export function isPrivateIpv4(host: string): boolean {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!match) {
		return false;
	}
	const a = Number.parseInt(match[1], 10);
	const b = Number.parseInt(match[2], 10);
	if (a === 0 || a === 10 || a === 127) {
		return true; // "this network", 10.0.0.0/8, loopback
	}
	if (a === 192 && b === 168) {
		return true; // 192.168.0.0/16
	}
	if (a === 172 && b >= 16 && b <= 31) {
		return true; // 172.16.0.0/12
	}
	if (a === 169 && b === 254) {
		return true; // 169.254.0.0/16 link-local
	}
	if (a === 100 && b >= 64 && b <= 127) {
		return true; // 100.64.0.0/10 CGNAT — Tailscale's range
	}
	return false;
}

/**
 * Whether a configured base URL is the public Cloudflare-fronted host (as
 * opposed to a LAN or Tailscale fallback). Only the Cloudflare path carries the
 * `CF-Access-*` service-token headers; sending them to a private address would
 * be pointless and leak the credentials onto the LAN. The heuristic treats any
 * loopback/private/link-local/CGNAT IP, `localhost`, and internal-only DNS
 * suffixes (`.local`, `.lan`, `.internal`, Tailscale's `.ts.net`) as direct;
 * everything else is assumed to be reached through the Cloudflare edge.
 */
export function isCloudflareBaseUrl(baseUrl: string): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	// IPv6 literals arrive bracketed (`[::1]`) — unwrap before matching.
	host = host.replace(/^\[/, "").replace(/\]$/, "");
	if (host.length === 0) {
		return false;
	}
	if (host === "localhost" || host.endsWith(".localhost")) {
		return false;
	}
	if (/\.(local|lan|internal|home|ts\.net)$/.test(host)) {
		return false;
	}
	if (isPrivateIpv4(host)) {
		return false;
	}
	// IPv6 loopback (::1), unique-local (fc00::/7 → fc/fd), link-local (fe80::/10).
	if (host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80:")) {
		return false;
	}
	return true;
}

/**
 * Case-insensitive lookup of a response header. Obsidian's `requestUrl`
 * normally lowercases header names, but we match defensively so the redirect
 * and content-type checks hold regardless of casing.
 */
export function getResponseHeader(response: RequestUrlResponse, name: string): string {
	const headers = response.headers ?? {};
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) {
			return headers[key] ?? "";
		}
	}
	return "";
}

/**
 * Escape a string for safe interpolation into a `RegExp`. The inline keyword is
 * user-editable, so it must be neutralised before it goes into the autocomplete
 * trigger and chip patterns (a stray `.` or `*` would otherwise misbehave).
 */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pattern for an `owner/repo` slug — a single slash, no whitespace. */
export const REPO_SLUG_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;

/**
 * Split an `owner/repo` slug into its parts, or null when malformed. Used by the
 * new-issue flow to turn the configured/picked repo into the path components and
 * the {@link IssueRef} for the card it inserts on success.
 */
export function splitRepo(value: string): { owner: string; repo: string } | null {
	const match = REPO_SLUG_PATTERN.exec(value.trim());
	if (!match) {
		return null;
	}
	return { owner: match[1], repo: match[2] };
}

/**
 * Build the `gitea-issue` fenced block inserted into a note after a successful
 * create, so the new issue becomes a live card in place. The trailing newline
 * keeps the fence on its own lines when it replaces an inline selection.
 */
export function buildIssueCardBlock(ref: IssueRef): string {
	return ["```gitea-issue", `${ref.owner}/${ref.repo}#${ref.index}`, "```", ""].join(
		"\n"
	);
}

/**
 * Build the backtick-wrapped inline reference — `` `GITEA:owner/repo:#123` `` —
 * that the chip post-processor and editor extension render as a compact
 * `● #123 Title open` link. The keyword is configurable, so it is threaded
 * through here to match the chip patterns. The inverse, space-light counterpart
 * to {@link buildIssueCardBlock} (issue #21).
 */
export function buildInlineChipReference(keyword: string, ref: IssueRef): string {
	return `\`${keyword}:${ref.owner}/${ref.repo}:#${ref.index}\``;
}

/**
 * Drop a `gitea-issue` card fence into the editor at the cursor, replacing any
 * selection. A fenced block only renders when its opening ``` starts a line, so a
 * newline is prefixed when the cursor sits mid-line — e.g. pasting an issue URL
 * at the end of a sentence.
 */
export function insertIssueCard(editor: Editor, ref: IssueRef): void {
	const cursor = editor.getCursor("from");
	const before = editor.getLine(cursor.line).slice(0, cursor.ch);
	const prefix = before.trim().length > 0 ? "\n" : "";
	editor.replaceSelection(prefix + buildIssueCardBlock(ref));
}

/**
 * Insert a reference to `ref` into the editor in the chosen {@link
 * IssueInsertFormat}: a full `gitea-issue` card or a compact inline status chip.
 * The card path reuses {@link insertIssueCard} (so it gets the start-of-line
 * newline guard); the inline path drops the backtick reference at the cursor,
 * replacing any selection, since a chip is valid mid-line (issue #21). A `none`
 * format leaves the note untouched (issue #37).
 */
export function insertIssueReference(
	editor: Editor,
	ref: IssueRef,
	format: IssueInsertFormat,
	keyword: string
): void {
	if (format === "none") {
		return;
	}
	if (format === "inline") {
		editor.replaceSelection(buildInlineChipReference(keyword, ref));
	} else {
		insertIssueCard(editor, ref);
	}
}

/**
 * Character offset of the first character of `line` (0-based) in `text`. Walks
 * newline by newline rather than splitting the whole document, so a large note
 * costs only as many scans as the target line index. Used by the right-click
 * format converters (issue #70) to turn a section's line range into the exact
 * character span a rewrite replaces — offsets are always derived here, never
 * hand-counted, so a bad number cannot splice into the wrong place.
 */
export function lineStartOffset(text: string, line: number): number {
	let offset = 0;
	for (let i = 0; i < line; i++) {
		const nl = text.indexOf("\n", offset);
		if (nl === -1) {
			return text.length;
		}
		offset = nl + 1;
	}
	return offset;
}

/**
 * Character offset just before `line`'s terminating newline (or the end of the
 * document for the last line). Paired with {@link lineStartOffset} to bound a
 * line-based section without consuming the newline that follows it (issue #70).
 */
export function lineEndOffset(text: string, line: number): number {
	const start = lineStartOffset(text, line);
	const nl = text.indexOf("\n", start);
	return nl === -1 ? text.length : nl;
}

/**
 * The source text that replaces an inline chip token when converting it to a
 * `gitea-issue` card (issue #70). A card is a fenced block and cannot sit inside
 * a sentence, so when the chip shares its line with other prose the fence is
 * pushed onto its own line with a leading newline — splitting the line into
 * text-before / fence / text-after rather than refusing the conversion (issue
 * #70 Q1). `textBeforeToken` is the same line's content up to the token; a blank
 * or whitespace-only prefix means the chip already starts its line, so no
 * leading newline is added. The card block builder's own trailing newline keeps
 * any text-after on the line following the closing fence.
 */
export function chipToCardReplacement(textBeforeToken: string, ref: IssueRef): string {
	const prefix = textBeforeToken.trim().length > 0 ? "\n" : "";
	return prefix + buildIssueCardBlock(ref);
}

/**
 * Reduce an issue body to a single plain-text line: take the first line, drop a
 * leading heading/quote/list marker, and unwrap links/inline-code/emphasis.
 * Deliberately avoids regex lookbehind (unsupported on mobile WebView).
 */
export function stripMarkdown(text: string): string {
	const firstLine = (text.split(/\r?\n/, 1)[0] ?? "").replace(
		/^\s{0,3}(#{1,6}\s+|>\s+|[-*+]\s+)/,
		""
	);
	return firstLine
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/[*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Truncate to `max` characters with an ellipsis; a non-positive max is a no-op. */
export function truncate(text: string, max: number): string {
	if (max <= 0 || text.length <= max) {
		return text;
	}
	return `${text.slice(0, max).trimEnd()}…`;
}

/** Render an ISO timestamp as a compact relative "x ago" string. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 45) {
		return "just now";
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.round(hours / 24);
	if (days < 7) {
		return `${days}d ago`;
	}
	const weeks = Math.round(days / 7);
	if (weeks < 5) {
		return `${weeks}w ago`;
	}
	const months = Math.round(days / 30);
	if (months < 12) {
		return `${months}mo ago`;
	}
	return `${Math.round(days / 365)}y ago`;
}

/** Up to two uppercase initials derived from a login, for the avatar chip. */
export function initialsFromLogin(login: string): string {
	const parts = login.split(/[\s._-]+/).filter(Boolean);
	if (parts.length === 0) {
		return "?";
	}
	if (parts.length === 1) {
		return parts[0].slice(0, 2).toUpperCase();
	}
	return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

/**
 * The issue-processor's `blocked-by:#N` label convention: a dependency on another
 * issue in the same repo. Returns the blocker's index, or null for an ordinary
 * label. Anchored and digit-only so a stray `blocked-by:#3-ish` does not match.
 */
export function parseBlockedByLabel(name: string): number | null {
	const match = /^blocked-by:#(\d+)$/.exec(name.trim());
	if (!match) {
		return null;
	}
	return Number.parseInt(match[1], 10);
}

/** Pick a readable foreground (#000 or #fff) for a label's background hex. */
export function labelTextColor(hex: string): string {
	const clean = hex.replace(/^#/, "");
	if (clean.length !== 6) {
		return "#ffffff";
	}
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.6 ? "#000000" : "#ffffff";
}
