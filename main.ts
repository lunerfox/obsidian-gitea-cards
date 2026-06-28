import {
	AbstractInputSuggest,
	App,
	ButtonComponent,
	Component,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	ExtraButtonComponent,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	RequestUrlResponse,
	Setting,
	TextComponent,
	TFile,
	editorLivePreviewField,
	requestUrl,
} from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";

/**
 * Minimum refresh interval, in seconds. The plugin floors any configured
 * interval to this value so a typo cannot hammer the Gitea server (Gitea
 * exposes no ETag/rate limiter — see the plan's throttling notes).
 */
export const MIN_REFRESH_SECONDS = 30;

/**
 * Upper bound on the exponential backoff applied after repeated fetch failures.
 * Once a card has fallen back to its stale, last-known state we keep retrying,
 * but never wait longer than this between attempts so it recovers promptly once
 * the server is reachable again.
 */
export const MAX_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Monotonic counter giving each rendered graph's arrowhead marker a unique id,
 * so two graphs on one note never share (and clobber) a `<marker>` definition.
 */
let graphRenderSeq = 0;

/**
 * Keys under which credentials are stored in {@link GiteaCardsSettings.secrets}
 * (data.json). Kept dash-namespaced (no colons) for tidiness.
 */
const SECRET_KEYS = {
	pat: "gitea-cards-gitea-pat",
	cfClientId: "gitea-cards-cf-access-client-id",
	cfClientSecret: "gitea-cards-cf-access-client-secret",
} as const;

/**
 * Settings persisted to data.json.
 *
 * NOTE: the Gitea PAT and Cloudflare Access service-token credentials are kept
 * here in `secrets`, in plaintext. The OS-keychain (`secretStorage`) backing was
 * removed because it is non-functional on headless/no-keyring hosts (e.g. the
 * containerised Obsidian here), where it silently fails to persist anything.
 * The trade-off: these credentials now live unencrypted in the vault's
 * data.json, so anything that syncs the vault also syncs the secrets.
 */
/**
 * How the new-issue / insert-issue flows drop a reference into the note: a full
 * `gitea-issue` card, a compact inline status chip (issue #21), or nothing at all
 * (issue #37). Cards are rich but space-hungry; the inline chip is a one-line
 * `● #123 Title open` link; `none` creates the issue without touching the note —
 * handy when a `gitea-search` block already lists the issue being added to.
 */
export type IssueInsertFormat = "card" | "inline" | "none";

export interface GiteaCardsSettings {
	baseUrl: string;
	keyword: string;
	refreshIntervalSeconds: number;
	truncationLength: number;
	/**
	 * Default number of recent comments shown when a card's comment thread is
	 * expanded (issue #40). A `comments: N` block key overrides this per card.
	 */
	commentPreviewCount: number;
	/**
	 * Whether to load images pasted into Gitea comments inline in expanded threads
	 * (issue #53). Default OFF — comments stay text-only as before. When ON, an
	 * `<img>` pointing at our Gitea is fetched through {@link
	 * GiteaCardsPlugin.loadAuthedImage} (carrying the token + `CF-Access-*` headers
	 * a plain `<img src>` can't), so private/CF-Access attachments resolve.
	 */
	showCommentImages: boolean;
	/**
	 * Whether single-issue cards show an attachment strip — image thumbnails and
	 * file chips for the issue's uploaded assets (issue #54). Default OFF, by the
	 * maintainer's scope answer: turning it on costs one extra `…/assets` GET per
	 * single `gitea-issue` card (coalesced/cached like every other request). When
	 * off, cards stay strictly one-call and rely only on comment-thread images
	 * (I2). List blocks (`gitea-search`/`gitea-milestone`) never fetch assets, so
	 * a wall of cards stays one request each regardless of this setting.
	 */
	showAttachments: boolean;
	defaultRepo: string;
	/**
	 * The repo the New issue modal last created an issue in. Seeds the repo picker
	 * ahead of {@link defaultRepo} so a battery of issues against one project does
	 * not need re-selecting each time (issue #23). Empty until the first create.
	 */
	lastRepo: string;
	/**
	 * The format the insert flows default to (card vs. inline status). Remembered
	 * across sessions so the choice sticks once changed in the modal (issue #21).
	 */
	insertFormat: IssueInsertFormat;
	/**
	 * Per-project accent colour, keyed by `owner/repo` and stored as a `#rrggbb`
	 * hex string. A card whose repo has an entry gets a subtle coloured left
	 * border so different projects are distinguishable at a glance (issue #19).
	 */
	repoAccents: Record<string, string>;
	/**
	 * Name of the label that marks an issue as "in progress" (issue #26). When an
	 * open issue carries this label, its inline chip shows an amber dot and an "in
	 * progress" badge instead of the usual green "open". Empty disables the
	 * feature — match is case-insensitive on the trimmed label name.
	 */
	inProgressLabel: string;
	/** Credential store keyed by the {@link SECRET_KEYS} values. */
	secrets: Record<string, string>;
}

/** Starting colour for a newly added repository accent (a calm blue). */
export const DEFAULT_ACCENT_COLOR = "#4c8dff";

export const DEFAULT_SETTINGS: GiteaCardsSettings = {
	baseUrl: "",
	keyword: "GITEA",
	refreshIntervalSeconds: 60,
	truncationLength: 160,
	commentPreviewCount: 3,
	showCommentImages: false,
	showAttachments: false,
	defaultRepo: "",
	lastRepo: "",
	insertFormat: "card",
	repoAccents: {},
	inProgressLabel: "",
	secrets: {},
};

/** A single label as returned by the Gitea issues API. */
interface GiteaLabel {
	id: number;
	name: string;
	/** Six-character hex without a leading `#`. */
	color: string;
}

/** Issue author. `avatar_url` is carried for future use; F1 renders initials. */
interface GiteaUser {
	login: string;
	avatar_url?: string;
}

interface GiteaMilestone {
	/** Gitea's milestone id — used to link a graph header's milestone (issue #47). */
	id: number;
	title: string;
}

/**
 * The subset of `GET /repos/{owner}/{repo}/milestones/{id|name}` the progress
 * block consumes. Gitea returns `open_issues`/`closed_issues` on the milestone
 * itself, so the bar needs no extra issue counting.
 */
interface GiteaMilestoneDetail {
	id: number;
	title: string;
	description: string | null;
	state: string;
	open_issues: number;
	closed_issues: number;
}

/**
 * The subset of `GET /repos/{owner}/{repo}/issues/{index}` a card consumes.
 * One call supplies everything the card shows — see the plan's card spec.
 */
interface GiteaIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: GiteaLabel[];
	comments: number;
	user: GiteaUser;
	milestone: GiteaMilestone | null;
	updated_at: string;
}

/**
 * An issue as returned by the list/search endpoints. Adds the fields a card
 * needs beyond the single-issue shape: `pull_request` (present on PRs, which the
 * list endpoints mix in and we drop) and `repository` (carried by the global
 * search so a card can show which repo a result came from).
 */
interface GiteaListIssue extends GiteaIssue {
	pull_request?: unknown;
	repository?: { full_name?: string } | null;
}

/**
 * The subset of `GET .../issues/{index}/comments` a thread preview consumes
 * (issue #40). The body is Markdown (Gitea comment bodies are Markdown) and is
 * rendered as such; `created_at` drives the relative timestamp.
 */
interface GiteaComment {
	id: number;
	body: string;
	user: GiteaUser;
	created_at: string;
}

/**
 * One attachment as returned by `GET .../issues/{index}/assets` (issue #54). The
 * card attachment strip needs the `name` (to label the chip and detect images by
 * extension) and `browser_download_url`; the latter's host is Gitea's `ROOT_URL`
 * (often a LAN address), so — like every other link — it is rewritten onto the
 * configured base before use rather than trusted as-is.
 */
interface GiteaAsset {
	id: number;
	name: string;
	size: number;
	uuid: string;
	browser_download_url: string;
}

/**
 * The attachment Gitea returns from a `POST .../assets` upload (issue #55) — the
 * outbound counterpart to {@link GiteaAsset}. Callers splice `![name](/attachments/
 * {uuid})` (or `[name](…)` for non-images) into an issue/comment body; the
 * `browser_download_url` host is Gitea's `ROOT_URL` and is rewritten onto the
 * configured base like every other link rather than trusted as-is.
 */
export interface GiteaAttachment {
	uuid: string;
	name: string;
	browser_download_url: string;
}

/** A parsed `owner/repo#index` reference. */
export interface IssueRef {
	owner: string;
	repo: string;
	index: number;
}

/** One search result: an issue paired with the ref used to link/render it. */
interface SearchResultItem {
	ref: IssueRef;
	issue: GiteaIssue;
}

/**
 * Wiring a card needs to render its on-card quick actions (F7). Supplied only by
 * the single-issue block (the only card backed by a per-card refresh and the
 * `owner/repo#index` cache entry an action invalidates); search/stale cards omit
 * it and render no buttons.
 */
interface CardActions {
	/** Re-fetch fresh and rebuild the card after a successful mutation. */
	onChanged: () => void;
	/**
	 * Pause/resume the card's auto-refresh while an inline editor (the comment
	 * box) is open, so an interval tick can't wipe half-typed input.
	 */
	setSuspended: (suspended: boolean) => void;
}

/**
 * Wiring a single-issue card needs to render its expandable comment-thread
 * preview (issue #40). Supplied only by the single-issue block; search/stale
 * list cards omit it and show the comment count as plain, non-clickable text.
 */
interface CommentPreviewOptions {
	/** Number of recent comments to show when the thread is expanded. */
	count: number;
	/** Whether the thread is currently expanded (drives lazy fetch + caret). */
	expanded: boolean;
	/** Flip the expansion state and re-render the card. */
	onToggle: () => void;
	/** Render child the rendered Markdown comment bodies attach their lifecycle to. */
	component: MarkdownRenderChild;
	/** Note path, so rendered comment Markdown resolves links/embeds correctly. */
	sourcePath: string;
}

/**
 * A milestone as returned by the list endpoint (`GET .../milestones`). The
 * new-issue modal needs the `id` to map a picked title back to the ID the
 * create endpoint expects, and `state` so it can offer only open milestones.
 */
interface GiteaMilestoneListItem {
	id: number;
	title: string;
	state: string;
}

/** A repo as returned by `GET /user/repos`, trimmed to what the picker needs. */
interface GiteaRepoSummary {
	full_name: string;
}

/**
 * The `permissions` block Gitea attaches to a repo for the authenticated token.
 * Used to scope-gate the on-card quick actions (F7): `push` (write) or `admin`
 * means the token can edit issues, so the action buttons are shown. Gitea has no
 * endpoint that reports a token's raw scopes, so repo-level write permission —
 * which already reflects a token lacking `write:issue` (it can't push) — is the
 * available signal; a stray `403` on a mutation is still surfaced as a notice.
 */
interface GiteaRepoPermissions {
	permissions?: {
		admin?: boolean;
		push?: boolean;
		pull?: boolean;
	};
}

/**
 * The trimmed-down issue shape the inline autocomplete (F6) offers: just enough
 * to render a `#123 — Title` suggestion and pick the index it inserts. Fetched
 * once per repo and filtered client-side so each keystroke costs no request.
 */
export interface InlineIssueSummary {
	index: number;
	title: string;
	state: string;
}

/**
 * One entry in the inline `EditorSuggest` dropdown — either a repo (stage 1,
 * after `GITEA:`) or an issue within a chosen repo (stage 2, after
 * `GITEA:owner/repo:`). A discriminated union so the renderer/inserter can tell
 * the two stages apart.
 */
type InlineSuggestion =
	| { kind: "repo"; repo: string }
	| { kind: "issue"; index: number; title: string; state: string };

/**
 * The `CreateIssueOption` body for `POST .../issues`. Note the convention the
 * plan calls out: `labels` are label **IDs** and `milestone` a milestone **ID**
 * (the inverse of the list filters, which take names) — the modal maps picker
 * selections to IDs before building this.
 */
interface CreateIssuePayload {
	title: string;
	body: string;
	labels: number[];
	milestone?: number;
	assignees: string[];
}

/** Raised for any non-success Gitea response so the card can show one line. */
class GiteaRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GiteaRequestError";
	}
}

/**
 * Outcome of a cache load: the best value available plus whether it is being
 * served as a stale fallback (the live fetch failed but we have a last-known
 * value) and the live error, when one occurred.
 */
export interface CacheLoadResult<T> {
	/** Best available value, or null when nothing has ever loaded. */
	value: T | null;
	/** True when `value` is last-known data served because the live fetch failed. */
	stale: boolean;
	/** The live error, if the most recent fetch attempt failed. */
	error: Error | null;
}

/** Backwards-compatible alias for a single-issue load result. */
export type IssueLoadResult = CacheLoadResult<GiteaIssue>;

/**
 * The cached payload behind {@link GiteaCardsPlugin.loadAuthedImage}: the raw
 * attachment bytes plus their content type. We cache the *bytes*, not a per-render
 * object URL — each render mints (and revokes) its own short-lived object URL from
 * the shared bytes, so the auto-refresh loop's constant card rebuilds never leak.
 */
export interface AuthedImage {
	data: ArrayBuffer;
	contentType: string;
}

/** Per-key state held by {@link CoalescingCache}. */
interface CacheEntry<T> {
	/** Last successfully fetched value — the stale/offline fallback source. */
	value: T | null;
	/** When `value` was last refreshed (ms epoch). */
	fetchedAt: number;
	/** In-flight request shared by every concurrent caller (the coalescer). */
	inFlight: Promise<CacheLoadResult<T>> | null;
	/** Consecutive failures, driving the exponential backoff. */
	failureCount: number;
	/** Earliest time (ms epoch) a new fetch is allowed while backing off. */
	nextRetryAt: number;
	/** Most recent error, surfaced on the stale/error card. */
	lastError: Error | null;
}

/**
 * Shared in-memory cache and request coalescer, generic over the lookup
 * argument and the fetched value.
 *
 * Gitea exposes no ETag and no rate limiter, so the plugin must self-throttle.
 * This collapses N callers pointing at the same key down to a single fetch per
 * interval (via a freshness window plus a shared in-flight promise) and, when
 * the server is unreachable, serves the last-known value as stale data while
 * backing off exponentially until it recovers. Single-issue cards (keyed by
 * `owner/repo#index`) and search blocks (keyed by their query) share it.
 */
export class CoalescingCache<TArg, TValue> {
	private readonly entries = new Map<string, CacheEntry<TValue>>();

	constructor(
		private readonly keyOf: (arg: TArg) => string,
		private readonly fetcher: (arg: TArg) => Promise<TValue>
	) {}

	private ensure(key: string): CacheEntry<TValue> {
		let entry = this.entries.get(key);
		if (!entry) {
			entry = {
				value: null,
				fetchedAt: 0,
				inFlight: null,
				failureCount: 0,
				nextRetryAt: 0,
				lastError: null,
			};
			this.entries.set(key, entry);
		}
		return entry;
	}

	/** Drop a cached entry so the next load fetches fresh (used after edits). */
	invalidate(arg: TArg): void {
		this.entries.delete(this.keyOf(arg));
	}

	/**
	 * Resolve the value for `arg`, fetching only when necessary. Data younger
	 * than ~80% of the refresh interval is reused without a network call so
	 * callers on the same key coalesce to one fetch per interval; concurrent
	 * callers share one in-flight request; and while backing off after failures
	 * the last-known value is returned as stale rather than re-hitting the server.
	 */
	async load(arg: TArg, intervalMs: number): Promise<CacheLoadResult<TValue>> {
		const entry = this.ensure(this.keyOf(arg));
		const now = Date.now();
		const maxAgeMs = Math.max(0, intervalMs * 0.8);

		// Fresh enough — serve from cache, no fetch (cross-caller coalescing).
		if (entry.value !== null && now - entry.fetchedAt < maxAgeMs) {
			return { value: entry.value, stale: false, error: null };
		}
		// Backing off — serve stale data (or the last error) without a request.
		if (now < entry.nextRetryAt) {
			return entry.value !== null
				? { value: entry.value, stale: true, error: entry.lastError }
				: { value: null, stale: false, error: entry.lastError };
		}
		// Coalesce every concurrent caller onto one shared request.
		if (!entry.inFlight) {
			entry.inFlight = this.runFetch(arg, entry, intervalMs);
		}
		return entry.inFlight;
	}

	private async runFetch(
		arg: TArg,
		entry: CacheEntry<TValue>,
		intervalMs: number
	): Promise<CacheLoadResult<TValue>> {
		try {
			const value = await this.fetcher(arg);
			entry.value = value;
			entry.fetchedAt = Date.now();
			entry.failureCount = 0;
			entry.nextRetryAt = 0;
			entry.lastError = null;
			return { value, stale: false, error: null };
		} catch (error) {
			const err =
				error instanceof Error ? error : new Error("Failed to load.");
			entry.failureCount += 1;
			entry.lastError = err;
			const backoff = Math.min(
				MAX_BACKOFF_MS,
				intervalMs * Math.pow(2, entry.failureCount - 1)
			);
			entry.nextRetryAt = Date.now() + backoff;
			return entry.value !== null
				? { value: entry.value, stale: true, error: err }
				: { value: null, stale: false, error: err };
		} finally {
			entry.inFlight = null;
		}
	}
}

/**
 * Shared cache/coalescer for single-issue cards, keyed by `owner/repo#index`.
 * A thin specialisation of {@link CoalescingCache} preserving the F1/F2 API.
 */
export class IssueCache extends CoalescingCache<IssueRef, GiteaIssue> {
	constructor(fetcher: (ref: IssueRef) => Promise<GiteaIssue>) {
		super((ref) => `${ref.owner}/${ref.repo}#${ref.index}`, fetcher);
	}
}

/**
 * Whether an element is currently shown — used to skip refreshing cards whose
 * note has scrolled off-screen or sits in a background leaf. Obsidian augments
 * HTMLElement with `isShown()`; fall back to layout checks where it is absent.
 */
function isElementVisible(el: HTMLElement): boolean {
	if (!el.isConnected) {
		return false;
	}
	const augmented = el as HTMLElement & { isShown?: () => boolean };
	if (typeof augmented.isShown === "function") {
		return augmented.isShown();
	}
	return el.offsetParent !== null;
}

const ISSUE_REF_PATTERN = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;

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
const ATTACHMENT_PATH_PATTERN = /\/attachments\/[^/]+/i;

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
const IMAGE_ASSET_PATTERN = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i;

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
let multipartBoundarySeq = 0;

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
const ISSUE_URL_PATH_PATTERN = /^\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/;

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
function inlineChipReferencePattern(keyword: string): RegExp {
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
function inlineChipSourcePattern(keyword: string): RegExp {
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
function createChipElement(
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
function isInProgress(issue: GiteaIssue, inProgressLabel: string): boolean {
	const target = inProgressLabel.trim().toLowerCase();
	if (!target) {
		return false;
	}
	return issue.labels.some(
		(label) => label.name.trim().toLowerCase() === target
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
function applyChipState(
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
function isPrivateIpv4(host: string): boolean {
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
function getResponseHeader(response: RequestUrlResponse, name: string): string {
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
const REPO_SLUG_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;

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

/** Default and hard cap for the number of cards a search block renders. */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

/** Issue states accepted by both Gitea list endpoints. */
const SEARCH_STATES = ["open", "closed", "all"] as const;

/**
 * A parsed `gitea-search` block. `repo` null means a global, cross-repo search;
 * `labels`/`milestones` are filter *names* (Gitea list filters take names, not
 * IDs — the inverse of issue creation).
 */
export interface SearchQuery {
	/** `owner/repo`, or null for a global cross-repo search. */
	repo: string | null;
	/** `open` | `closed` | `all`. */
	state: string;
	/** Label names to filter on (comma-separated in the block). */
	labels: string[];
	/** Milestone names to filter on. */
	milestones: string[];
	/** Free-text keyword query. */
	q: string | null;
	/** Maximum number of results to render, capped at {@link SEARCH_MAX_LIMIT}. */
	limit: number;
	/**
	 * How the results are laid out: a compact `table` of chip-like rows (the
	 * default, issue #33) or a vertical list of full `cards`.
	 */
	layout: SearchLayout;
}

/** Search result layouts. `table` is the compact, chip-like default (issue #33). */
export const SEARCH_LAYOUTS = ["table", "cards"] as const;
export type SearchLayout = (typeof SEARCH_LAYOUTS)[number];

function splitList(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * Parse a `gitea-search` block body (`key: value` lines) into a {@link SearchQuery}.
 * Returns an error string instead of a query for malformed input so the block
 * can show one line of guidance. An empty body is a valid global open-issue list.
 */
export function parseSearchQuery(source: string): {
	query: SearchQuery | null;
	error: string | null;
} {
	const query: SearchQuery = {
		repo: null,
		state: "open",
		labels: [],
		milestones: [],
		q: null,
		limit: SEARCH_DEFAULT_LIMIT,
		layout: "table",
	};

	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		const sep = line.indexOf(":");
		if (sep === -1) {
			return {
				query: null,
				error: `Expected "key: value" lines; got "${line}".`,
			};
		}
		const key = line.slice(0, sep).trim().toLowerCase();
		const value = line.slice(sep + 1).trim();
		switch (key) {
			case "repo":
				query.repo = value.length > 0 ? value : null;
				break;
			case "state": {
				const state = value.toLowerCase();
				if (!SEARCH_STATES.includes(state as (typeof SEARCH_STATES)[number])) {
					return {
						query: null,
						error: `Unknown state "${value}" — use open, closed, or all.`,
					};
				}
				query.state = state;
				break;
			}
			case "label":
			case "labels":
				query.labels = splitList(value);
				break;
			case "milestone":
			case "milestones":
				query.milestones = splitList(value);
				break;
			case "q":
			case "query":
				query.q = value.length > 0 ? value : null;
				break;
			case "limit": {
				const parsed = Number.parseInt(value, 10);
				if (Number.isFinite(parsed) && parsed > 0) {
					query.limit = Math.min(parsed, SEARCH_MAX_LIMIT);
				}
				break;
			}
			case "layout":
			case "view": {
				const layout = value.toLowerCase();
				// Tolerate the singular "card" as an alias for "cards".
				const normalized = layout === "card" ? "cards" : layout;
				if (
					!SEARCH_LAYOUTS.includes(normalized as SearchLayout)
				) {
					return {
						query: null,
						error: `Unknown layout "${value}" — use table or cards.`,
					};
				}
				query.layout = normalized as SearchLayout;
				break;
			}
			default:
				return { query: null, error: `Unknown field "${key}".` };
		}
	}

	if (query.repo && !/^[^/\s]+\/[^/\s]+$/.test(query.repo)) {
		return {
			query: null,
			error: `Invalid repo "${query.repo}" — use owner/repo.`,
		};
	}
	return { query, error: null };
}

/** Stable cache key for a search query (order-insensitive on the filter lists). */
export function searchQueryKey(query: SearchQuery): string {
	return JSON.stringify({
		repo: query.repo,
		state: query.state,
		labels: [...query.labels].sort(),
		milestones: [...query.milestones].sort(),
		q: query.q,
		limit: query.limit,
	});
}

/**
 * Serialise a {@link SearchQuery} back into the `key: value` body of a
 * `gitea-search` block, emitting only the fields that differ from their defaults
 * so the generated block stays minimal (an all-default query yields an empty
 * body, which {@link parseSearchQuery} reads as a global open-issue table). The
 * inverse of {@link parseSearchQuery} and the engine behind the query wizard.
 */
export function buildSearchQuerySource(query: SearchQuery): string {
	const lines: string[] = [];
	if (query.repo) {
		lines.push(`repo: ${query.repo}`);
	}
	if (query.state !== "open") {
		lines.push(`state: ${query.state}`);
	}
	if (query.labels.length > 0) {
		lines.push(`labels: ${query.labels.join(", ")}`);
	}
	if (query.milestones.length > 0) {
		lines.push(`milestones: ${query.milestones.join(", ")}`);
	}
	if (query.q) {
		lines.push(`query: ${query.q}`);
	}
	if (query.limit !== SEARCH_DEFAULT_LIMIT) {
		lines.push(`limit: ${query.limit}`);
	}
	if (query.layout !== "table") {
		lines.push(`layout: ${query.layout}`);
	}
	return lines.join("\n");
}

/**
 * Wrap {@link buildSearchQuerySource} in a fenced `gitea-search` block, ready to
 * drop into a note. A default (empty-body) query still produces a valid fence.
 */
export function buildSearchBlock(query: SearchQuery): string {
	const body = buildSearchQuerySource(query);
	const inner = body.length > 0 ? `\n${body}` : "";
	return "```gitea-search" + inner + "\n```\n";
}

/**
 * Drop a `gitea-search` block into the editor at the cursor, replacing any
 * selection. Mirrors {@link insertIssueCard}'s start-of-line guard so the fence
 * always opens its own line even when the cursor sits mid-sentence.
 */
export function insertSearchBlock(editor: Editor, query: SearchQuery): void {
	const cursor = editor.getCursor("from");
	const before = editor.getLine(cursor.line).slice(0, cursor.ch);
	const prefix = before.trim().length > 0 ? "\n" : "";
	editor.replaceSelection(prefix + buildSearchBlock(query));
}

/**
 * A parsed `gitea-milestone` block. Both fields are required: `repo` in
 * `owner/repo` form and `milestone` the milestone's *name* (Gitea's milestone
 * endpoint resolves either an id or a name in the path — we pass the name).
 */
export interface MilestoneQuery {
	/** `owner/repo`. */
	repo: string;
	/** Milestone name (passed straight through to the `{id|name}` path slot). */
	milestone: string;
}

/**
 * Parse a `gitea-milestone` block body (`key: value` lines) into a
 * {@link MilestoneQuery}. Returns an error string instead of a query for
 * malformed or incomplete input so the block can show one line of guidance.
 */
export function parseMilestoneQuery(source: string): {
	query: MilestoneQuery | null;
	error: string | null;
} {
	let repo = "";
	let milestone = "";

	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		const sep = line.indexOf(":");
		if (sep === -1) {
			return {
				query: null,
				error: `Expected "key: value" lines; got "${line}".`,
			};
		}
		const key = line.slice(0, sep).trim().toLowerCase();
		const value = line.slice(sep + 1).trim();
		switch (key) {
			case "repo":
				repo = value;
				break;
			case "milestone":
				milestone = value;
				break;
			default:
				return { query: null, error: `Unknown field "${key}".` };
		}
	}

	if (!repo) {
		return { query: null, error: "Missing repo — add a repo: owner/repo line." };
	}
	if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
		return { query: null, error: `Invalid repo "${repo}" — use owner/repo.` };
	}
	if (!milestone) {
		return {
			query: null,
			error: "Missing milestone — add a milestone: name line.",
		};
	}
	return { query: { repo, milestone }, error: null };
}

/** Stable cache key for a milestone query. */
export function milestoneQueryKey(query: MilestoneQuery): string {
	return `${query.repo}!milestone:${query.milestone}`;
}

/**
 * Percentage (0–100, rounded) of a milestone's issues that are closed. An empty
 * milestone (no open or closed issues) reads as 0% rather than dividing by zero.
 */
export function milestoneProgressPercent(open: number, closed: number): number {
	const total = open + closed;
	if (total <= 0) {
		return 0;
	}
	return Math.round((closed / total) * 100);
}

/**
 * Build the milestone link from the configured base URL — like
 * {@link buildIssueUrl}, never the API host (Gitea's `ROOT_URL` is the LAN IP).
 */
export function buildMilestoneUrl(
	baseUrl: string,
	repo: string,
	milestoneId: number
): string {
	const base = baseUrl.replace(/\/+$/, "");
	return `${base}/${repo}/milestone/${milestoneId}`;
}

/** Layout orientations for the dependency graph. `TB` is top-to-bottom. */
export const GRAPH_DIRECTIONS = ["TB", "LR"] as const;
export type GraphDirection = (typeof GRAPH_DIRECTIONS)[number];

/**
 * A parsed `gitea-graph` block. Shares the same scoping vocabulary as a
 * {@link SearchQuery} (repo/state/labels/milestones/q/limit) so a milestone (or
 * any filter) selects the issue set rendered as a dependency DAG; `direction`
 * picks the layout orientation. Unlike search, the default `state` is `all` and
 * the default `limit` the maximum, so a graph shows a milestone's *completed*
 * blockers too — they are what establish the execution order (issue #39).
 */
export interface GraphQuery {
	/** `owner/repo`, or null for a global cross-repo set. */
	repo: string | null;
	/** `open` | `closed` | `all` (defaults to `all` for graphs). */
	state: string;
	/** Label names to filter on. */
	labels: string[];
	/** Milestone names to filter on — the primary scoping key. */
	milestones: string[];
	/** Free-text keyword query. */
	q: string | null;
	/** Maximum number of nodes, capped at {@link SEARCH_MAX_LIMIT}. */
	limit: number;
	/** Layout orientation. */
	direction: GraphDirection;
}

/** One node in the rendered dependency graph. */
export interface GraphNode {
	/** Stable `owner/repo#index` id (unique across repos in a global set). */
	id: string;
	/** The ref used to link the node back to Gitea. */
	ref: IssueRef;
	number: number;
	title: string;
	/** Collapsed to `open` | `closed`. */
	state: string;
	/** Open issue carrying the configured in-progress label. */
	inProgress: boolean;
	/**
	 * Open issue with at least one still-open blocker — what the issue processor
	 * is *not* yet able to pick up. Drives the dimmed/dashed node styling so the
	 * currently-unblocked work stands out (issue #39).
	 */
	blocked: boolean;
}

/** One dependency edge, drawn blocker → dependent (both node ids). */
export interface GraphEdge {
	from: string;
	to: string;
}

/** The fetched graph: nodes plus the edges between in-set issues. */
export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/**
	 * Milestone name → Gitea id, gathered from the scoped issues so the header can
	 * link each milestone in its subtitle (issue #47). A milestone with no issue
	 * in the set has no entry and falls back to plain text.
	 */
	milestoneIds: Record<string, number>;
}

/** Stable `owner/repo#index` id for a node, matching the issue cache key. */
export function graphNodeId(ref: IssueRef): string {
	return `${ref.owner}/${ref.repo}#${ref.index}`;
}

/**
 * Parse a `gitea-graph` block body (`key: value` lines) into a {@link GraphQuery}.
 * Accepts the same scoping keys as `gitea-search` plus `direction` (TB|LR).
 * Returns an error string instead of a query for malformed input so the block
 * can show one line of guidance. An empty body is a valid global graph of all
 * open-or-closed issues, but in practice a `milestone:` (or `repo:`) scope is
 * expected.
 */
export function parseGraphQuery(source: string): {
	query: GraphQuery | null;
	error: string | null;
} {
	const query: GraphQuery = {
		repo: null,
		state: "all",
		labels: [],
		milestones: [],
		q: null,
		limit: SEARCH_MAX_LIMIT,
		direction: "TB",
	};

	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		const sep = line.indexOf(":");
		if (sep === -1) {
			return {
				query: null,
				error: `Expected "key: value" lines; got "${line}".`,
			};
		}
		const key = line.slice(0, sep).trim().toLowerCase();
		const value = line.slice(sep + 1).trim();
		switch (key) {
			case "repo":
				query.repo = value.length > 0 ? value : null;
				break;
			case "state": {
				const state = value.toLowerCase();
				if (!SEARCH_STATES.includes(state as (typeof SEARCH_STATES)[number])) {
					return {
						query: null,
						error: `Unknown state "${value}" — use open, closed, or all.`,
					};
				}
				query.state = state;
				break;
			}
			case "label":
			case "labels":
				query.labels = splitList(value);
				break;
			case "milestone":
			case "milestones":
				query.milestones = splitList(value);
				break;
			case "q":
			case "query":
				query.q = value.length > 0 ? value : null;
				break;
			case "limit": {
				const parsed = Number.parseInt(value, 10);
				if (Number.isFinite(parsed) && parsed > 0) {
					query.limit = Math.min(parsed, SEARCH_MAX_LIMIT);
				}
				break;
			}
			case "direction":
			case "dir": {
				// Tolerate Mermaid's "TD" as an alias for top-to-bottom.
				const dir = value.toUpperCase() === "TD" ? "TB" : value.toUpperCase();
				if (!GRAPH_DIRECTIONS.includes(dir as GraphDirection)) {
					return {
						query: null,
						error: `Unknown direction "${value}" — use TB or LR.`,
					};
				}
				query.direction = dir as GraphDirection;
				break;
			}
			default:
				return { query: null, error: `Unknown field "${key}".` };
		}
	}

	if (query.repo && !/^[^/\s]+\/[^/\s]+$/.test(query.repo)) {
		return {
			query: null,
			error: `Invalid repo "${query.repo}" — use owner/repo.`,
		};
	}
	return { query, error: null };
}

/**
 * Stable cache key for a graph query. Excludes `direction`, which only affects
 * layout — so two blocks differing only in orientation share one fetched set.
 */
export function graphQueryKey(query: GraphQuery): string {
	return (
		"graph!" +
		JSON.stringify({
			repo: query.repo,
			state: query.state,
			labels: [...query.labels].sort(),
			milestones: [...query.milestones].sort(),
			q: query.q,
			limit: query.limit,
		})
	);
}

/**
 * The scope a graph block renders, used as the header's title line: the repo
 * (the configured default when the block omits one, "all repositories" for a
 * global cross-repo set). Pure and exported for testing; the renderer pairs it
 * with {@link graphSubtitle} to form a title/subtitle heading above the DAG
 * (#41, sized down to match the node text in #44).
 */
export function graphTitle(query: GraphQuery, defaultRepo: string): string {
	const repo = query.repo ?? (defaultRepo.length > 0 ? defaultRepo : null);
	return repo ?? "All repositories";
}

/**
 * The milestone(s) a graph block is scoped to, used as the header's subtitle
 * line beneath {@link graphTitle}. Empty when the query names no milestone, so
 * the renderer can skip the subtitle entirely. Pure and exported for testing.
 */
export function graphSubtitle(query: GraphQuery): string {
	if (query.milestones.length === 0) {
		return "";
	}
	const label = query.milestones.length === 1 ? "milestone" : "milestones";
	return `${label} ${query.milestones.join(", ")}`;
}

/**
 * Serialise a {@link GraphQuery} back into the `key: value` body of a
 * `gitea-graph` block, emitting only the fields that differ from their defaults
 * so the generated block stays minimal. The graph defaults differ from search —
 * `state` is `all` and `limit` is the maximum (see {@link parseGraphQuery}) — so
 * a milestone-only graph yields a single `milestones:` line. The inverse of
 * {@link parseGraphQuery} and the engine behind the graph wizard (issue #43).
 */
export function buildGraphQuerySource(query: GraphQuery): string {
	const lines: string[] = [];
	if (query.repo) {
		lines.push(`repo: ${query.repo}`);
	}
	if (query.state !== "all") {
		lines.push(`state: ${query.state}`);
	}
	if (query.labels.length > 0) {
		lines.push(`labels: ${query.labels.join(", ")}`);
	}
	if (query.milestones.length > 0) {
		lines.push(`milestones: ${query.milestones.join(", ")}`);
	}
	if (query.q) {
		lines.push(`query: ${query.q}`);
	}
	if (query.limit !== SEARCH_MAX_LIMIT) {
		lines.push(`limit: ${query.limit}`);
	}
	if (query.direction !== "TB") {
		lines.push(`direction: ${query.direction}`);
	}
	return lines.join("\n");
}

/**
 * Wrap {@link buildGraphQuerySource} in a fenced `gitea-graph` block, ready to
 * drop into a note. A default (empty-body) query still produces a valid fence.
 */
export function buildGraphBlock(query: GraphQuery): string {
	const body = buildGraphQuerySource(query);
	const inner = body.length > 0 ? `\n${body}` : "";
	return "```gitea-graph" + inner + "\n```\n";
}

/**
 * Drop a `gitea-graph` block into the editor at the cursor, replacing any
 * selection. Mirrors {@link insertSearchBlock}'s start-of-line guard so the
 * fence always opens its own line even when the cursor sits mid-sentence.
 */
export function insertGraphBlock(editor: Editor, query: GraphQuery): void {
	const cursor = editor.getCursor("from");
	const before = editor.getLine(cursor.line).slice(0, cursor.ch);
	const prefix = before.trim().length > 0 ? "\n" : "";
	editor.replaceSelection(prefix + buildGraphBlock(query));
}

/**
 * Assign each node a layer by longest path from a root (a node with no in-set
 * blockers): `layer = max(layer of blockers) + 1`, 0 for roots. This stacks an
 * issue strictly below everything that must close before it, so a layer reads as
 * "can start once the previous layers are done". Native Gitea dependencies can
 * in principle form a cycle; a visiting-set guard breaks one at layer 0 rather
 * than recursing forever. Pure and exported for testing.
 */
export function assignGraphLayers(
	nodes: { id: string }[],
	edges: GraphEdge[]
): Map<string, number> {
	const ids = new Set(nodes.map((node) => node.id));
	const blockers = new Map<string, string[]>();
	for (const node of nodes) {
		blockers.set(node.id, []);
	}
	for (const edge of edges) {
		if (ids.has(edge.from) && ids.has(edge.to)) {
			blockers.get(edge.to)?.push(edge.from);
		}
	}
	const layer = new Map<string, number>();
	const visiting = new Set<string>();
	const depth = (id: string): number => {
		const cached = layer.get(id);
		if (cached !== undefined) {
			return cached;
		}
		if (visiting.has(id)) {
			return 0; // Cycle guard — break the loop rather than recurse forever.
		}
		visiting.add(id);
		let d = 0;
		for (const blocker of blockers.get(id) ?? []) {
			d = Math.max(d, depth(blocker) + 1);
		}
		visiting.delete(id);
		layer.set(id, d);
		return d;
	};
	for (const node of nodes) {
		depth(node.id);
	}
	return layer;
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

export default class GiteaCardsPlugin extends Plugin {
	settings: GiteaCardsSettings = DEFAULT_SETTINGS;

	/**
	 * Shared cache/coalescer for every card on screen. Created in `onload` so
	 * each plugin lifecycle starts with an empty cache.
	 */
	cache: IssueCache = new IssueCache((ref) => this.fetchIssue(ref));

	/**
	 * Shared cache/coalescer for a card's expandable comment-thread preview (issue
	 * #40), keyed by `owner/repo#index` like {@link cache} but holding the issue's
	 * comment list. Routing through the same throttle/backoff/stale machinery means
	 * an expanded thread refreshes on the card's cadence and degrades to last-known
	 * comments when Gitea is unreachable, like the rest of the plugin.
	 */
	commentsCache: CoalescingCache<IssueRef, GiteaComment[]> =
		new CoalescingCache(
			(ref) => `${ref.owner}/${ref.repo}#${ref.index}`,
			(ref) => this.fetchComments(ref)
		);

	/**
	 * Shared cache/coalescer for `gitea-search` blocks, keyed by the query. Reuses
	 * the same throttle/backoff/stale machinery as {@link cache} so duplicate
	 * search blocks coalesce to one request per interval.
	 */
	searchCache: CoalescingCache<SearchQuery, SearchResultItem[]> =
		new CoalescingCache(searchQueryKey, (query) =>
			this.fetchSearchIssues(query)
		);

	/**
	 * Shared cache/coalescer for `gitea-milestone` blocks, keyed by repo+name.
	 * Reuses the same throttle/backoff/stale lifecycle as the other caches.
	 */
	milestoneCache: CoalescingCache<MilestoneQuery, GiteaMilestoneDetail> =
		new CoalescingCache(milestoneQueryKey, (query) =>
			this.fetchMilestone(query)
		);

	/**
	 * Shared cache/coalescer for `gitea-graph` blocks, keyed by the query. One
	 * graph fetch fans out to the scoped issue list plus a per-issue dependency
	 * call, so wrapping the whole thing in the same throttle/backoff/stale
	 * lifecycle keeps duplicate graphs (and the refresh interval) honest (#39).
	 */
	graphCache: CoalescingCache<GraphQuery, GraphData> = new CoalescingCache(
		graphQueryKey,
		(query) => this.fetchGraph(query)
	);

	/**
	 * Cache/coalescer for the inline repo picker (F6 stage 1). Keyed by a single
	 * constant — there is only one repo list per token — so the refresh-interval
	 * freshness window keeps keystroke-driven lookups off the network.
	 */
	repoListCache: CoalescingCache<null, string[]> = new CoalescingCache(
		() => "user-repos",
		() => this.fetchRepos()
	);

	/**
	 * Cache/coalescer for the inline issue picker (F6 stage 2), keyed by
	 * `owner/repo`. Each repo's issue list is fetched once per interval and
	 * filtered client-side, so typing a number/title costs no extra request.
	 */
	inlineIssueCache: CoalescingCache<string, InlineIssueSummary[]> =
		new CoalescingCache(
			(repo) => repo,
			(repo) => this.fetchInlineIssues(repo)
		);

	/**
	 * Cache/coalescer for the per-repo write check that scope-gates the on-card
	 * quick actions (F7), keyed by `owner/repo`. One probe per repo per interval
	 * across every card on that repo, reusing the same throttle/backoff lifecycle.
	 */
	repoWriteCache: CoalescingCache<string, boolean> = new CoalescingCache(
		(repo) => repo,
		(repo) => this.fetchRepoCanWrite(repo)
	);

	/**
	 * Shared cache/coalescer for authenticated image attachments (issue #52),
	 * keyed by `img:<absolute-url>`. Holds the fetched bytes so N cards showing
	 * the same image coalesce to one fetch per interval, just like the issue and
	 * search caches. {@link loadAuthedImage} turns a cached entry into a per-render
	 * object URL.
	 */
	imageCache: CoalescingCache<string, AuthedImage> = new CoalescingCache(
		(url) => `img:${url}`,
		(url) => this.fetchAuthedImage(url)
	);

	/**
	 * Shared cache/coalescer for a single-issue card's attachment list (issue #54),
	 * keyed by `assets:owner/repo#index`. Only single `gitea-issue` cards load
	 * assets, and only when the "show attachments" setting is on, so this stays
	 * empty for list blocks; duplicate cards on the same issue coalesce to one
	 * `…/assets` GET per interval and degrade to last-known assets when offline,
	 * like every other request.
	 */
	assetsCache: CoalescingCache<IssueRef, GiteaAsset[]> = new CoalescingCache(
		(ref) => `assets:${ref.owner}/${ref.repo}#${ref.index}`,
		(ref) => this.fetchIssueAssets(ref)
	);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new GiteaCardsSettingTab(this.app, this));

		// Each block becomes a MarkdownRenderChild so its refresh timer is torn
		// down automatically when the note scrolls away, closes, or the plugin
		// unloads (see IssueCardChild).
		this.registerMarkdownCodeBlockProcessor(
			"gitea-issue",
			(source, el, ctx: MarkdownPostProcessorContext) => {
				el.empty();
				const { block, error } = parseIssueBlock(source);
				if (!block) {
					this.renderError(
						el,
						error ??
							"Expected a single reference in owner/repo#index form."
					);
					return;
				}
				ctx.addChild(
					new IssueCardChild(
						el,
						this,
						block.ref,
						ctx.sourcePath,
						block.comments
					)
				);
			}
		);

		// A search block renders a list of cards from a query. Same lifecycle and
		// shared-cache throttling as the single-issue block.
		this.registerMarkdownCodeBlockProcessor(
			"gitea-search",
			(source, el, ctx: MarkdownPostProcessorContext) => {
				el.empty();
				const { query, error } = parseSearchQuery(source);
				if (!query) {
					this.renderError(
						el,
						error ?? "Invalid search query."
					);
					return;
				}
				ctx.addChild(new SearchBlockChild(el, this, query));
			}
		);

		// A milestone block renders a progress bar from the milestone's own
		// open/closed counts. Same lifecycle and shared-cache throttling.
		this.registerMarkdownCodeBlockProcessor(
			"gitea-milestone",
			(source, el, ctx: MarkdownPostProcessorContext) => {
				el.empty();
				const { query, error } = parseMilestoneQuery(source);
				if (!query) {
					this.renderError(el, error ?? "Invalid milestone query.");
					return;
				}
				ctx.addChild(new MilestoneBlockChild(el, this, query));
			}
		);

		// A graph block renders a milestone's (or a query's) issues as a
		// dependency DAG — nodes coloured by state, edges drawn blocker →
		// dependent, blocked work dimmed. Same lifecycle and shared-cache
		// throttling as the other blocks (issue #39).
		this.registerMarkdownCodeBlockProcessor(
			"gitea-graph",
			(source, el, ctx: MarkdownPostProcessorContext) => {
				el.empty();
				const { query, error } = parseGraphQuery(source);
				if (!query) {
					this.renderError(el, error ?? "Invalid graph query.");
					return;
				}
				ctx.addChild(new GraphBlockChild(el, this, query));
			}
		);

		// Create an issue from Obsidian. When invoked from an editor we capture it
		// so the new card can be dropped in at the cursor on success.
		this.addCommand({
			id: "new-issue",
			name: "New issue",
			callback: () => {
				const editor =
					this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
				new NewIssueModal(this, { editor }).open();
			},
		});

		// Same modal, prefilled from the selection; on success the selection is
		// replaced in place with the resulting card (so the prose becomes a ticket).
		this.addCommand({
			id: "convert-selection-to-issue",
			name: "Convert selection to issue",
			editorCallback: (editor: Editor) => {
				new NewIssueModal(this, {
					editor,
					body: editor.getSelection(),
				}).open();
			},
		});

		// Insert a card for an existing issue: pick a repo and one of its issues
		// from a modal, dropping the `gitea-issue` fence in at the cursor. The
		// keyboard-light counterpart to the inline `GITEA:` autocomplete below.
		this.addCommand({
			id: "insert-existing-issue",
			name: "Insert existing issue",
			editorCallback: (editor: Editor) => {
				new InsertIssueModal(this, editor).open();
			},
		});

		// Build a `gitea-search` block without memorising its field syntax: pick a
		// repo, state, labels, milestone, keyword, limit, and layout from a form,
		// watch the block update live, then drop it in at the cursor (issue #34).
		this.addCommand({
			id: "build-search-query",
			name: "Build search query",
			editorCallback: (editor: Editor) => {
				new SearchQueryWizardModal(this, editor).open();
			},
		});

		// Build a `gitea-graph` block — a dependency DAG for a set of milestones —
		// without memorising its field syntax: pick a repo, one or more milestones,
		// labels, state, keyword, node limit, and orientation from a form, watch the
		// block update live, then drop it in at the cursor (issue #43).
		this.addCommand({
			id: "build-graph-view",
			name: "Build graph view",
			editorCallback: (editor: Editor) => {
				new GraphQueryWizardModal(this, editor).open();
			},
		});

		// Inline single-issue autocomplete: typing `GITEA:` suggests repos, then
		// `GITEA:owner/repo:` suggests that repo's issues. Auto-torn-down on unload.
		this.registerEditorSuggest(new GiteaInlineSuggest(this));

		// Turn a backtick-wrapped `GITEA:owner/repo:#123` (an inline-code span)
		// into a lightweight inline chip (`● #123 Title open/closed`). A bare,
		// un-backticked reference in prose is intentionally left alone (issue #14).
		// The post-processor covers Reading view; the editor extension below
		// renders the same chip in Live Preview (editing view).
		this.registerMarkdownPostProcessor((el, ctx) => {
			this.processInlineChips(el, ctx);
		});
		this.registerEditorExtension(inlineChipEditorExtension(this));

		// Pasting a Gitea issue URL drops a live card in its place. We only act
		// when the whole clipboard payload is a single issue URL on the configured
		// host (see parseIssueUrl) — ordinary text and unrelated links paste
		// untouched. Skipped if another handler already consumed the event.
		this.registerEvent(
			this.app.workspace.on(
				"editor-paste",
				(evt: ClipboardEvent, editor: Editor) => {
					if (evt.defaultPrevented) {
						return;
					}
					const text = evt.clipboardData?.getData("text/plain");
					if (!text) {
						return;
					}
					const ref = parseIssueUrl(this.settings.baseUrl, text);
					if (!ref) {
						return;
					}
					evt.preventDefault();
					insertIssueCard(editor, ref);
				}
			)
		);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<GiteaCardsSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		// Never share DEFAULT_SETTINGS.secrets by reference, or mutations would
		// leak across reloads; start from a fresh copy of whatever was persisted.
		this.settings.secrets = { ...(data?.secrets ?? {}) };
		// Same for the per-repo accent map — a fresh copy so add/remove edits in
		// the settings tab never mutate the shared DEFAULT_SETTINGS object.
		this.settings.repoAccents = { ...(data?.repoAccents ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Effective refresh interval in milliseconds, floored at the safe minimum. */
	get refreshIntervalMs(): number {
		const seconds = Math.max(
			MIN_REFRESH_SECONDS,
			this.settings.refreshIntervalSeconds
		);
		return seconds * 1000;
	}

	async getSecret(key: string): Promise<string | null> {
		return this.settings.secrets[key] ?? null;
	}

	async setSecret(key: string, value: string): Promise<void> {
		if (value.length === 0) {
			delete this.settings.secrets[key];
		} else {
			this.settings.secrets[key] = value;
		}
		await this.saveSettings();
	}

	/**
	 * Request headers for a Gitea call: the PAT as `Authorization: token <PAT>`
	 * (the literal lowercase `token` is mandatory) plus the Cloudflare Access
	 * service-token headers — but the latter ONLY when the base URL is the
	 * public Cloudflare host. On a LAN or Tailscale base URL the request reaches
	 * Gitea directly, so the `CF-Access-*` headers are both useless and a
	 * credential leak onto the local network; {@link isCloudflareBaseUrl} draws
	 * that line. Cloudflare consumes its headers at the edge and proxies the
	 * `Authorization` through to Gitea, so the two layers ride together.
	 */
	private async buildAuthHeaders(): Promise<Record<string, string>> {
		const headers: Record<string, string> = { Accept: "application/json" };
		const pat = await this.getSecret(SECRET_KEYS.pat);
		if (pat) {
			headers.Authorization = `token ${pat}`;
		}
		if (isCloudflareBaseUrl(this.settings.baseUrl)) {
			const cfClientId = await this.getSecret(SECRET_KEYS.cfClientId);
			const cfClientSecret = await this.getSecret(SECRET_KEYS.cfClientSecret);
			if (cfClientId && cfClientSecret) {
				headers["CF-Access-Client-Id"] = cfClientId;
				headers["CF-Access-Client-Secret"] = cfClientSecret;
			}
		}
		return headers;
	}

	/**
	 * Translate a non-success HTTP status into a single-line {@link
	 * GiteaRequestError}, disambiguating the two auth layers on the Cloudflare
	 * path (see the plan's "Error disambiguation"):
	 *
	 * - A 3xx whose `Location` points at `*.cloudflareaccess.com` is an edge
	 *   reject — the request never reached Gitea. We must NOT auto-follow it
	 *   (the target is an HTML login page, not JSON), so the redirect surfaces
	 *   as a service-token failure.
	 * - A 401/403 carrying a Gitea JSON body means Access let the request
	 *   through but the Gitea PAT was rejected — a token/scope problem. A
	 *   401/403 *without* a JSON body is treated as an edge reject too, since it
	 *   came from Cloudflare rather than Gitea.
	 *
	 * `notFoundMessage` tailors the 404 to the call site (a missing issue vs. a
	 * missing image). This is the status-only half shared by the JSON-API reads
	 * ({@link ensureGiteaOk}) and the binary image loader ({@link
	 * loadAuthedImage}) — the latter must NOT reject a non-JSON body, since a
	 * successful attachment fetch returns `image/*` bytes.
	 */
	private ensureGiteaStatusOk(
		response: RequestUrlResponse,
		notFoundMessage: string
	): void {
		if (response.status >= 300 && response.status < 400) {
			const location = getResponseHeader(response, "location");
			if (location.includes("cloudflareaccess.com")) {
				throw new GiteaRequestError(
					"Cloudflare Access rejected the service token."
				);
			}
			throw new GiteaRequestError(
				`Unexpected redirect (HTTP ${response.status}).`
			);
		}
		if (response.status === 401 || response.status === 403) {
			const contentType = getResponseHeader(response, "content-type");
			if (contentType.toLowerCase().includes("application/json")) {
				throw new GiteaRequestError(
					"Gitea token invalid or insufficient scope."
				);
			}
			throw new GiteaRequestError(
				"Cloudflare Access rejected the service token."
			);
		}
		if (response.status === 404) {
			throw new GiteaRequestError(notFoundMessage);
		}
		if (response.status >= 400) {
			throw new GiteaRequestError(`Gitea returned HTTP ${response.status}.`);
		}
	}

	/**
	 * The JSON-API variant of {@link ensureGiteaStatusOk}: after the status
	 * taxonomy passes, additionally reject a 2xx whose body is not JSON.
	 */
	private ensureGiteaOk(
		response: RequestUrlResponse,
		notFoundMessage: string
	): void {
		this.ensureGiteaStatusOk(response, notFoundMessage);
		// A 2xx response whose body is not JSON means the request reached
		// something other than the Gitea API — most often the base URL points at
		// a web login page or reverse proxy that answers 200 with HTML. Reading
		// `response.json` here would surface a raw "JSON Parse error: Unrecognized
		// token '<'"; turn it into one actionable line instead.
		const contentType = getResponseHeader(response, "content-type").toLowerCase();
		if (contentType && !contentType.includes("json")) {
			throw new GiteaRequestError(
				"Gitea returned a non-JSON response — check the base URL points at your Gitea server, not a login or proxy page."
			);
		}
	}

	/**
	 * Probe the configured server and credentials for the settings "Test
	 * connection" button. Hits the unauthenticated `/version` endpoint first to
	 * confirm the base URL actually reaches a Gitea API — a wrong URL or a proxy
	 * login page is caught here as a redirect or non-JSON response — then `/user`
	 * to confirm the stored token authenticates. Returns a one-line success
	 * summary; throws {@link GiteaRequestError} with an actionable message on any
	 * failure, so the settings handler can show it verbatim.
	 */
	async testConnection(): Promise<string> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		if (!base) {
			throw new GiteaRequestError("Set the Gitea base URL first.");
		}
		const headers = await this.buildAuthHeaders();
		const versionResponse = await requestUrl({
			url: `${base}/api/v1/version`,
			method: "GET",
			headers,
			throw: false,
		});
		this.ensureGiteaOk(versionResponse, "No Gitea API found at this base URL.");
		const version =
			(versionResponse.json as { version?: string })?.version ?? "unknown";

		const hasToken = Boolean(await this.getSecret(SECRET_KEYS.pat));
		if (!hasToken) {
			return `Reached Gitea ${version}, but no API token is set.`;
		}
		const userResponse = await requestUrl({
			url: `${base}/api/v1/user`,
			method: "GET",
			headers,
			throw: false,
		});
		this.ensureGiteaOk(userResponse, "Could not look up the token's user.");
		const login =
			(userResponse.json as { login?: string })?.login ?? "unknown";
		return `Connected to Gitea ${version} as ${login}.`;
	}

	/**
	 * Fetch a single issue via the supported `requestUrl()` (CORS- and
	 * mobile-safe). `throw: false` lets us inspect the status and body instead of
	 * throwing on 4xx.
	 */
	async fetchIssue(ref: IssueRef): Promise<GiteaIssue> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${encodeURIComponent(
			ref.owner
		)}/${encodeURIComponent(ref.repo)}/issues/${ref.index}`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
		});
		this.ensureGiteaOk(response, "Issue not found.");
		return response.json as GiteaIssue;
	}

	/**
	 * Fetch an issue's comments via `GET .../issues/{index}/comments` (issue #40).
	 * Gitea returns the full thread in chronological order; the caller slices the
	 * most recent N. Called lazily — only when a card's thread is expanded — and
	 * routed through {@link commentsCache} so it shares the card's refresh cadence.
	 */
	async fetchComments(ref: IssueRef): Promise<GiteaComment[]> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/comments`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
		});
		this.ensureGiteaOk(response, "Issue not found.");
		return (response.json as GiteaComment[]) ?? [];
	}

	/**
	 * Fetch an issue's uploaded attachments via `GET .../issues/{index}/assets`
	 * (issue #54) — the optional second call behind the "show attachments" setting.
	 * Returns `[{ name, browser_download_url, … }]`; the strip thumbnails the image
	 * ones and chips the rest. Routed through {@link assetsCache} so it shares the
	 * card's refresh cadence and coalesces across duplicate cards.
	 */
	async fetchIssueAssets(ref: IssueRef): Promise<GiteaAsset[]> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/assets`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
		});
		this.ensureGiteaOk(response, "Issue not found.");
		return (response.json as GiteaAsset[]) ?? [];
	}

	/**
	 * Fetch an attachment's raw bytes through the supported `requestUrl()` with the
	 * full auth headers (issue #52). An Obsidian `<img src>` can't carry the `token`
	 * + `CF-Access-*` headers {@link buildAuthHeaders} adds, so private attachments
	 * must be loaded here instead. Verified against Gitea's web `/attachments/<uuid>`
	 * route: it honours `Authorization: token` (200 `image/*` with the PAT, 404
	 * without), so the markdown src can be fetched directly — no API asset lookup.
	 *
	 * Reuses {@link ensureGiteaStatusOk} (not {@link ensureGiteaOk}) so the
	 * CF-Access-302 vs 401/403 taxonomy still applies, *without* rejecting the
	 * non-JSON image body a success returns. The raw bytes are cached by {@link
	 * imageCache}; {@link loadAuthedImage} mints the per-render object URL.
	 */
	async fetchAuthedImage(url: string): Promise<AuthedImage> {
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
		});
		this.ensureGiteaStatusOk(response, "Image not found.");
		return {
			data: response.arrayBuffer,
			contentType:
				getResponseHeader(response, "content-type") ||
				"application/octet-stream",
		};
	}

	/**
	 * Resolve an authenticated attachment URL to a render-ready object URL (issue
	 * #52), the foundation every image-display ticket rests on. Loads the bytes
	 * through the shared {@link imageCache} (so duplicate images coalesce to one
	 * fetch and degrade to last-known bytes when Gitea is unreachable), wraps them
	 * in a `Blob`, and returns `URL.createObjectURL(blob)`.
	 *
	 * The object URL is registered for revocation on `owner`'s unload, so the
	 * auto-refresh loop's constant card rebuilds never leak blobs — pass the
	 * rendering {@link MarkdownRenderChild}. Throws {@link GiteaRequestError} (with
	 * the auth-taxonomy message) when no bytes are available, so the caller can
	 * render a "🔒 image blocked" placeholder; serves stale bytes silently when the
	 * live fetch fails but a previous load succeeded.
	 *
	 * Uses only web-standard `Blob`/`URL` APIs, so it works on mobile.
	 */
	async loadAuthedImage(url: string, owner: Component): Promise<string> {
		const result = await this.imageCache.load(url, this.refreshIntervalMs);
		if (!result.value) {
			throw (
				result.error ??
				new GiteaRequestError("Image could not be loaded.")
			);
		}
		const blob = new Blob([result.value.data], {
			type: result.value.contentType,
		});
		const objectUrl = URL.createObjectURL(blob);
		owner.register(() => URL.revokeObjectURL(objectUrl));
		return objectUrl;
	}

	/**
	 * Build the query string shared by both list endpoints. Gitea list filters
	 * take label/milestone *names* (the inverse of issue creation), and `type=
	 * issues` keeps PRs out — both list endpoints otherwise mix them in.
	 */
	private buildSearchParams(query: SearchQuery): string {
		const params = new URLSearchParams();
		params.set("type", "issues");
		params.set("state", query.state);
		params.set("limit", String(query.limit));
		params.set("page", "1");
		if (query.labels.length > 0) {
			params.set("labels", query.labels.join(","));
		}
		if (query.milestones.length > 0) {
			params.set("milestones", query.milestones.join(","));
		}
		if (query.q) {
			params.set("q", query.q);
		}
		return params.toString();
	}

	/**
	 * Resolve the {@link IssueRef} for one search result. Per-repo queries know
	 * the repo from the query; global results carry their own `repository`.
	 * Returns null when neither is available (so the item is skipped).
	 */
	private refForResult(query: SearchQuery, item: GiteaListIssue): IssueRef | null {
		const fullName = query.repo ?? item.repository?.full_name ?? "";
		const slash = fullName.indexOf("/");
		if (slash <= 0 || slash === fullName.length - 1) {
			return null;
		}
		return {
			owner: fullName.slice(0, slash),
			repo: fullName.slice(slash + 1),
			index: item.number,
		};
	}

	/**
	 * Run a `gitea-search` query and return the cards to render. A `repo:` query
	 * hits `GET /repos/{owner}/{repo}/issues`; without one it hits the global
	 * `GET /repos/issues/search`. PRs are excluded by `type=issues` and, as a
	 * belt-and-braces guard, by dropping any item carrying `pull_request`.
	 *
	 * The list is refetched in full each interval rather than incrementally via
	 * `since`/`updated_at`: an incremental fetch only returns *changed* issues, so
	 * it cannot detect items that dropped out of the filter (e.g. a state change),
	 * which would leave the rendered membership wrong. The shared cache, freshness
	 * window, and interval floor already keep the request rate in check.
	 */
	async fetchSearchIssues(query: SearchQuery): Promise<SearchResultItem[]> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const params = this.buildSearchParams(query);
		const url = query.repo
			? `${base}/api/v1/repos/${query.repo
					.split("/")
					.map(encodeURIComponent)
					.join("/")}/issues?${params}`
			: `${base}/api/v1/repos/issues/search?${params}`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
		});
		this.ensureGiteaOk(
			response,
			query.repo ? "Repository not found." : "Search endpoint not found."
		);

		const items = (response.json as GiteaListIssue[]) ?? [];
		const results: SearchResultItem[] = [];
		for (const item of items) {
			if (item.pull_request != null) {
				continue; // Drop PRs — list endpoints mix them in with issues.
			}
			const ref = this.refForResult(query, item);
			if (ref) {
				results.push({ ref, issue: item });
			}
		}
		return results;
	}

	/**
	 * Fetch one milestone via `GET /repos/{owner}/{repo}/milestones/{id|name}`.
	 * The path slot accepts a name or an id; we pass the configured name. The
	 * returned model already carries `open_issues`/`closed_issues`, so the bar
	 * needs no extra issue counting.
	 */
	async fetchMilestone(query: MilestoneQuery): Promise<GiteaMilestoneDetail> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const repoPath = query.repo.split("/").map(encodeURIComponent).join("/");
		const url = `${base}/api/v1/repos/${repoPath}/milestones/${encodeURIComponent(
			query.milestone
		)}`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
		});
		this.ensureGiteaOk(response, "Milestone not found.");
		return response.json as GiteaMilestoneDetail;
	}

	/**
	 * The repo a graph block is scoped to: its explicit `repo:` line, falling back
	 * to the configured default. Null only when neither is set (a true global,
	 * cross-repo graph). Matches the scope the header renders and links to, so the
	 * fetch and the milestone validation below agree with what the user sees.
	 */
	private graphRepo(query: GraphQuery): string | null {
		return query.repo ?? (this.settings.defaultRepo || null);
	}

	/** Reuse the search list machinery to fetch a graph's scoped issue set. */
	private graphToSearchQuery(query: GraphQuery): SearchQuery {
		return {
			repo: this.graphRepo(query),
			state: query.state,
			labels: query.labels,
			milestones: query.milestones,
			q: query.q,
			limit: query.limit,
			layout: "table",
		};
	}

	/**
	 * Verify every milestone name a graph filters on actually exists in the repo.
	 * Gitea's list endpoints silently *ignore* an unknown milestone name and return
	 * the whole unfiltered set, so a typo'd or deleted milestone would otherwise
	 * render as "all issues" rather than an error (issue #48). One
	 * `GET .../milestones/{name}` per named milestone — a 404 means it does not
	 * exist; the `{id|name}` endpoint matches by name regardless of state, so a
	 * graph of a *completed* milestone still validates. Throws a single
	 * {@link GiteaRequestError} naming the missing milestone(s).
	 */
	private async assertMilestonesExist(
		repo: string,
		milestones: string[]
	): Promise<void> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const repoPath = this.repoPath(repo);
		const headers = await this.buildAuthHeaders();
		const missing: string[] = [];
		await Promise.all(
			milestones.map(async (name) => {
				const url = `${base}/api/v1/repos/${repoPath}/milestones/${encodeURIComponent(
					name
				)}`;
				const response = await requestUrl({
					url,
					method: "GET",
					headers,
					throw: false,
				});
				if (response.status === 404) {
					missing.push(name);
					return;
				}
				// Surface auth/redirect/other failures with the shared disambiguation.
				this.ensureGiteaOk(response, `Milestone "${name}" not found.`);
			})
		);
		if (missing.length > 0) {
			const label = missing.length === 1 ? "Milestone" : "Milestones";
			const names = missing.map((name) => `"${name}"`).join(", ");
			throw new GiteaRequestError(
				`${label} ${names} not found in ${repo} — check the milestone name.`
			);
		}
	}

	/**
	 * Fetch one issue's native dependencies (its blockers) via
	 * `GET .../issues/{index}/dependencies`. Gitea returns the blocking issues
	 * themselves (each with `state` and, cross-repo, `repository`), so one call
	 * supplies both the edges into this node and whether it is still blocked. An
	 * issue with no dependencies returns `200 []`, not a 404. PRs are dropped by
	 * the caller via the `pull_request` guard.
	 */
	async fetchIssueDependencies(ref: IssueRef): Promise<GiteaListIssue[]> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/dependencies`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({ url, method: "GET", headers, throw: false });
		this.ensureGiteaOk(response, "Issue not found.");
		return (response.json as GiteaListIssue[]) ?? [];
	}

	/**
	 * Build the dependency graph for a `gitea-graph` block: fetch the scoped issue
	 * set (reusing the search list endpoints), then each issue's native
	 * dependencies, and assemble nodes + edges.
	 *
	 * Edges are drawn blocker → dependent from two sources, deduplicated: Gitea's
	 * **native** issue dependencies (the issue's stated requirement) and this
	 * repo's `blocked-by:#N` **label** convention (which the issue processor also
	 * honours — and which costs no extra request, since labels ride along with the
	 * list fetch). Only edges whose endpoints are both in the scoped set are kept,
	 * so a milestone graph stays self-contained. A node is `blocked` when it is
	 * open and any of its blockers is still open — native blockers carry their own
	 * state; a label blocker contributes only when it too is in the set.
	 */
	async fetchGraph(query: GraphQuery): Promise<GraphData> {
		// A milestone filter Gitea can't resolve is silently dropped, returning the
		// whole repo instead of the milestone's issues — validate the names up front
		// so a typo'd or missing milestone errors rather than rendering every issue
		// (issue #48). Only checkable against a concrete repo; a true global graph
		// (no repo and no default) has no single repo to validate against.
		const repo = this.graphRepo(query);
		if (query.milestones.length > 0 && repo) {
			await this.assertMilestonesExist(repo, query.milestones);
		}
		const items = await this.fetchSearchIssues(this.graphToSearchQuery(query));
		const inSet = new Map<string, SearchResultItem>();
		for (const item of items) {
			inSet.set(graphNodeId(item.ref), item);
		}

		// One dependency call per scoped issue, run concurrently.
		const depLists = await Promise.all(
			items.map((item) => this.fetchIssueDependencies(item.ref))
		);

		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];
		const milestoneIds: Record<string, number> = {};
		const edgeSeen = new Set<string>();
		const addEdge = (from: string, to: string): void => {
			if (from === to || !inSet.has(from) || !inSet.has(to)) {
				return;
			}
			const key = `${from}->${to}`;
			if (edgeSeen.has(key)) {
				return;
			}
			edgeSeen.add(key);
			edges.push({ from, to });
		};

		items.forEach((item, index) => {
			const { ref, issue } = item;
			const id = graphNodeId(ref);
			const isClosed = issue.state === "closed";
			const inProgress =
				!isClosed && isInProgress(issue, this.settings.inProgressLabel);
			let blocked = false;

			// Native dependencies — authoritative blocker state.
			for (const dep of depLists[index]) {
				if (dep.pull_request != null) {
					continue;
				}
				const depRepo =
					dep.repository?.full_name ?? `${ref.owner}/${ref.repo}`;
				const depId = `${depRepo}#${dep.number}`;
				addEdge(depId, id);
				if (!isClosed && dep.state === "open") {
					blocked = true;
				}
			}

			// blocked-by:#N labels — same-repo, free from the list fetch.
			for (const label of issue.labels) {
				const blockerIndex = parseBlockedByLabel(label.name);
				if (blockerIndex == null) {
					continue;
				}
				const blockerId = `${ref.owner}/${ref.repo}#${blockerIndex}`;
				addEdge(blockerId, id);
				const blocker = inSet.get(blockerId);
				if (!isClosed && blocker && blocker.issue.state === "open") {
					blocked = true;
				}
			}

			// Remember the milestone's id (the scoped issues carry it) so the header
			// can link it back to Gitea (issue #47).
			if (issue.milestone && typeof issue.milestone.id === "number") {
				milestoneIds[issue.milestone.title] = issue.milestone.id;
			}

			nodes.push({
				id,
				ref,
				number: issue.number,
				title: issue.title,
				state: isClosed ? "closed" : "open",
				inProgress,
				blocked,
			});
		});

		return { nodes, edges, milestoneIds };
	}

	/** Encode an `owner/repo` slug into the `{owner}/{repo}` path segment. */
	private repoPath(repo: string): string {
		return repo.split("/").map(encodeURIComponent).join("/");
	}

	/**
	 * List the repos the token can see, for the new-issue repo picker. Drops any
	 * entry missing a `full_name` so the dropdown only offers usable slugs.
	 */
	async fetchRepos(): Promise<string[]> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/user/repos?limit=50`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({ url, method: "GET", headers, throw: false });
		this.ensureGiteaOk(response, "Could not list repositories.");
		const repos = (response.json as GiteaRepoSummary[]) ?? [];
		return repos
			.map((repo) => repo.full_name)
			.filter((name): name is string => typeof name === "string" && name.length > 0);
	}

	/**
	 * List a repo's issues (numbers + titles) for the inline autocomplete. Uses
	 * the repo issues endpoint with `type=issues` so PRs are excluded, and drops
	 * any item still carrying `pull_request` as a belt-and-braces guard.
	 */
	async fetchInlineIssues(repo: string): Promise<InlineIssueSummary[]> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.repoPath(
			repo
		)}/issues?type=issues&state=all&limit=50`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({ url, method: "GET", headers, throw: false });
		this.ensureGiteaOk(response, "Repository not found.");
		const items = (response.json as GiteaListIssue[]) ?? [];
		return items
			.filter((item) => item.pull_request == null)
			.map((item) => ({
				index: item.number,
				title: item.title,
				state: item.state,
			}));
	}

	/**
	 * Repo slugs for the inline picker, served through the shared cache so a burst
	 * of keystrokes coalesces to one request per interval. Returns an empty list
	 * (rather than throwing) when the lookup fails, so the popup just stays empty.
	 */
	async loadRepoList(): Promise<string[]> {
		const result = await this.repoListCache.load(null, this.refreshIntervalMs);
		return result.value ?? [];
	}

	/**
	 * Issue summaries for a repo's inline picker, served through the shared cache
	 * like {@link loadRepoList}. Empty on failure so the popup degrades quietly.
	 */
	async loadInlineIssues(repo: string): Promise<InlineIssueSummary[]> {
		const result = await this.inlineIssueCache.load(
			repo,
			this.refreshIntervalMs
		);
		return result.value ?? [];
	}

	/**
	 * Fetch a repo's labels so the modal can map picked names to the IDs the
	 * create endpoint requires (creation takes IDs, list filters take names).
	 */
	async fetchLabels(repo: string): Promise<GiteaLabel[]> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.repoPath(repo)}/labels?limit=50`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({ url, method: "GET", headers, throw: false });
		this.ensureGiteaOk(response, "Repository not found.");
		return (response.json as GiteaLabel[]) ?? [];
	}

	/**
	 * Fetch a repo's open milestones for the modal dropdown, again so a picked
	 * title can be mapped to the milestone ID the create endpoint expects.
	 */
	async fetchMilestones(repo: string): Promise<GiteaMilestoneListItem[]> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.repoPath(
			repo
		)}/milestones?state=open&limit=50`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({ url, method: "GET", headers, throw: false });
		this.ensureGiteaOk(response, "Repository not found.");
		return (response.json as GiteaMilestoneListItem[]) ?? [];
	}

	/**
	 * Create an issue via `POST .../issues` and return it. `labels`/`milestone`
	 * in the payload are already mapped to IDs by the caller. A 201 carries the
	 * created issue, whose `number` the caller turns into a `gitea-issue` card.
	 */
	async createIssue(repo: string, payload: CreateIssuePayload): Promise<GiteaIssue> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.repoPath(repo)}/issues`;
		const headers = await this.buildAuthHeaders();
		headers["Content-Type"] = "application/json";
		const response = await requestUrl({
			url,
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			throw: false,
		});
		this.ensureGiteaOk(response, "Repository not found.");
		return response.json as GiteaIssue;
	}

	/** Build the `{owner}/{repo}/issues/{index}` API path segment for a ref. */
	private issuePath(ref: IssueRef): string {
		return `${encodeURIComponent(ref.owner)}/${encodeURIComponent(
			ref.repo
		)}/issues/${ref.index}`;
	}

	/**
	 * Issue a write request (POST/PATCH/DELETE) to the Gitea API, serialising the
	 * body as JSON when present. Shared by the on-card quick actions so each one is
	 * a single line; the same {@link ensureGiteaOk} disambiguation as the reads
	 * turns an Access/Gitea rejection into one user-facing message.
	 */
	private async giteaMutate(
		url: string,
		method: "POST" | "PATCH" | "DELETE",
		body?: unknown
	): Promise<RequestUrlResponse> {
		const headers = await this.buildAuthHeaders();
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		const response = await requestUrl({
			url,
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			throw: false,
		});
		this.ensureGiteaOk(response, "Issue not found.");
		return response;
	}

	/**
	 * Whether the token can write to a repo's issues, for scope-gating the quick
	 * actions. Reads the `permissions` block on `GET /repos/{owner}/{repo}`:
	 * `push`/`admin` means edits are allowed. See {@link GiteaRepoPermissions} for
	 * why repo-level write is the signal (Gitea exposes no token-scope endpoint).
	 */
	async fetchRepoCanWrite(repo: string): Promise<boolean> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.repoPath(repo)}`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({ url, method: "GET", headers, throw: false });
		this.ensureGiteaOk(response, "Repository not found.");
		const data = response.json as GiteaRepoPermissions;
		return Boolean(data.permissions?.push || data.permissions?.admin);
	}

	/**
	 * Whether to show quick-action buttons for a ref's repo, served through the
	 * shared cache so a screenful of cards coalesces to one probe per repo. Returns
	 * false on any failure, so the buttons stay hidden rather than error.
	 */
	async loadCanWriteIssues(ref: IssueRef): Promise<boolean> {
		return this.loadRepoCanWrite(`${ref.owner}/${ref.repo}`);
	}

	/**
	 * The repo-string counterpart of {@link loadCanWriteIssues}, for callers that
	 * hold an `owner/repo` slug rather than an {@link IssueRef} (the new-issue modal
	 * scope-gating its image picker, issue #57). Shares the same coalescing cache,
	 * so the probe is reused across the card and the modal. False on any failure.
	 */
	async loadRepoCanWrite(repo: string): Promise<boolean> {
		const result = await this.repoWriteCache.load(
			repo,
			this.refreshIntervalMs
		);
		return result.value ?? false;
	}

	/** Toggle an issue open/closed via `PATCH .../issues/{index}` with `{state}`. */
	async setIssueState(ref: IssueRef, state: "open" | "closed"): Promise<void> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}`;
		await this.giteaMutate(url, "PATCH", { state });
	}

	/** Post a comment via `POST .../issues/{index}/comments` with `{body}`. */
	async addIssueComment(ref: IssueRef, body: string): Promise<void> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/comments`;
		await this.giteaMutate(url, "POST", { body });
	}

	/**
	 * Replace an issue's body via `PATCH .../issues/{index}` with `{body}`. Used by
	 * the new-issue modal to append uploaded-image markdown after the issue exists
	 * (issue #57) — Gitea has no single-call create-with-upload, so the order is
	 * create → upload assets → PATCH the body with the returned `![](…)` markdown.
	 */
	async editIssueBody(ref: IssueRef, body: string): Promise<void> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}`;
		await this.giteaMutate(url, "PATCH", { body });
	}

	/**
	 * Upload a file to a multipart asset endpoint and return the created
	 * attachment (issue #55) — the shared engine behind {@link uploadIssueAsset}
	 * and {@link uploadCommentAsset}. Unlike {@link giteaMutate} (which forces a
	 * JSON body), this sends a hand-built {@link buildMultipart} body under its
	 * generated `multipart/form-data` boundary, layered on top of the same auth
	 * headers — so the `Authorization: token` + `CF-Access-*` credentials ride
	 * alongside the multipart content type behind Cloudflare Access. The success
	 * response is JSON (`{ uuid, name, browser_download_url }`); a server-side
	 * size/type rejection comes back as a 4xx and is surfaced through the shared
	 * {@link ensureGiteaOk} taxonomy. Requires a token with `write:issue` scope —
	 * callers gate the UI on {@link loadCanWriteIssues} before reaching here.
	 */
	private async uploadAsset(
		url: string,
		filename: string,
		mime: string,
		bytes: ArrayBuffer
	): Promise<GiteaAttachment> {
		const headers = await this.buildAuthHeaders();
		const { body, contentType } = buildMultipart(
			"attachment",
			filename,
			mime,
			bytes
		);
		headers["Content-Type"] = contentType;
		const response = await requestUrl({
			url,
			method: "POST",
			headers,
			body,
			throw: false,
		});
		this.ensureGiteaOk(response, "Issue not found.");
		return response.json as GiteaAttachment;
	}

	/**
	 * Attach a file to an issue via `POST .../issues/{index}/assets` (issue #55).
	 * The natural target for both the comment quick-action and the new-issue modal
	 * (an issue's assets live under the issue, not a not-yet-existing comment).
	 */
	async uploadIssueAsset(
		ref: IssueRef,
		filename: string,
		mime: string,
		bytes: ArrayBuffer
	): Promise<GiteaAttachment> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/assets`;
		return this.uploadAsset(url, filename, mime, bytes);
	}

	/**
	 * Attach a file to an existing comment via
	 * `POST .../issues/comments/{comment_id}/assets` (issue #55). Comment assets
	 * key off the comment id, not the issue index, so the repo is passed
	 * separately rather than via an {@link IssueRef}.
	 */
	async uploadCommentAsset(
		repo: string,
		commentId: number,
		filename: string,
		mime: string,
		bytes: ArrayBuffer
	): Promise<GiteaAttachment> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.repoPath(
			repo
		)}/issues/comments/${commentId}/assets`;
		return this.uploadAsset(url, filename, mime, bytes);
	}

	/**
	 * Add labels to an issue via `POST .../issues/{index}/labels`. Takes label
	 * **IDs** (the create-vs-list IDs-vs-names asymmetry the plan calls out).
	 */
	async addIssueLabels(ref: IssueRef, labelIds: number[]): Promise<void> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/labels`;
		await this.giteaMutate(url, "POST", { labels: labelIds });
	}

	/** Remove one label via `DELETE .../issues/{index}/labels/{id}` (by ID). */
	async removeIssueLabel(ref: IssueRef, labelId: number): Promise<void> {
		const base = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/labels/${labelId}`;
		await this.giteaMutate(url, "DELETE");
	}

	/**
	 * Render a cache load result into `el`, replacing whatever was there. Renders
	 * the card (greyed out with a stale badge when serving last-known data) or,
	 * when nothing has ever loaded, a one-line error.
	 */
	renderCardResult(
		el: HTMLElement,
		ref: IssueRef,
		result: IssueLoadResult,
		actions?: CardActions,
		commentPreview?: CommentPreviewOptions
	): void {
		el.empty();
		if (result.value) {
			// `actions` is passed even on a stale (offline) card so the manual
			// refresh button stays available to retry; the write-gated quick
			// actions inside are themselves dropped on a stale card by
			// renderIssueCard (they would only fail without a live server).
			this.renderIssueCard(
				el,
				ref,
				result.value,
				result.stale,
				actions,
				commentPreview
			);
			return;
		}
		this.renderError(el, result.error?.message ?? "Failed to load issue.");
	}

	/**
	 * Render a search-result block into `el`, replacing whatever was there. The
	 * results are laid out per the query's `layout` (issue #33): a compact,
	 * chip-like {@link renderSearchTable table} (the default) or a vertical list
	 * of full cards. A single stale notice covers the whole block when serving
	 * last-known data; each result names its own repo (issue #22).
	 */
	renderSearchResult(
		el: HTMLElement,
		query: SearchQuery,
		result: CacheLoadResult<SearchResultItem[]>,
		onRefresh?: () => void
	): void {
		el.empty();
		if (!result.value) {
			this.renderError(el, result.error?.message ?? "Failed to load issues.");
			return;
		}

		const container = el.createDiv({ cls: "gitea-search" });
		if (result.stale) {
			const notice = container.createDiv({ cls: "gitea-search__notice" });
			notice.setText(
				"Gitea is unreachable — showing last-known results."
			);
		}

		// A "Refresh" button that forces a fresh fetch on demand (issue #36),
		// pinned to the block's bottom-right corner (issue #45).
		if (onRefresh) {
			this.renderCornerRefresh(container, "Refresh results now", onRefresh);
		}

		// An "Add issue" button seeded from the query, so a new issue starts in
		// the table's repo and inherits its milestone/labels filter — the new
		// issue then shows up in this same table on the next refresh (issue #35).
		this.renderSearchToolbar(container, query);

		if (result.value.length === 0) {
			container.createDiv({
				cls: "gitea-card gitea-card--empty",
				text: "No issues match this query.",
			});
			return;
		}
		if (query.layout === "table") {
			this.renderSearchTable(container, query, result.value);
			return;
		}
		// Every card names its own repo on the status line (issue #22), so both
		// global and per-repo search results carry their repo without extra work.
		for (const item of result.value) {
			this.renderIssueCard(container, item.ref, item.issue, false);
		}
	}

	/**
	 * Render the search block's toolbar — a "Refresh" button that forces a fresh
	 * fetch on demand (issue #36) and an "Add issue" button that opens the
	 * new-issue form prefilled from the query (issue #35). The repo is carried
	 * over only for a repo-scoped search; its milestone (when the query filters on
	 * exactly one) and label filters travel with it so the created issue matches
	 * the table. A global, cross-repo search seeds no repo, so the modal falls
	 * back to the remembered/default repo with no metadata prefill (the picked
	 * names belong to no single repo). The form defaults to inserting nothing
	 * into the note, since the new issue surfaces in this same table on refresh
	 * (issue #37); the author can still pick a card or inline chip.
	 */
	private renderSearchToolbar(
		container: HTMLElement,
		query: SearchQuery
	): void {
		const toolbar = container.createDiv({ cls: "gitea-search__toolbar" });
		new ButtonComponent(toolbar)
			.setIcon("plus")
			.setButtonText("Add issue")
			.setTooltip("Create an issue prefilled from this search")
			.onClick(() => {
				const editor =
					this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ??
					null;
				const scoped = query.repo !== null;
				new NewIssueModal(this, {
					editor,
					repo: query.repo ?? undefined,
					labels: scoped ? query.labels : undefined,
					milestone:
						scoped && query.milestones.length === 1
							? query.milestones[0]
							: undefined,
					// The issue lands in this same search table on the next refresh,
					// so default to inserting nothing into the note (issue #37).
					defaultInsertFormat: "none",
				}).open();
			});
	}

	/**
	 * Render search results as a compact table of chip-like rows (issue #33) —
	 * a state dot, the linked issue number, the title, and a status badge, the
	 * same vocabulary the inline chips use so a set of issues reads at a glance.
	 * A global (cross-repo) query adds an `owner/repo` column so each row still
	 * names its source. Each row carries its repo's accent border (issue #30).
	 */
	private renderSearchTable(
		container: HTMLElement,
		query: SearchQuery,
		items: SearchResultItem[]
	): void {
		// A global query mixes repos, so name each one; a per-repo query already
		// has the repo in the block, so the column would just repeat it.
		const showRepo = query.repo === null;
		const table = container.createEl("table", { cls: "gitea-search-table" });
		const body = table.createEl("tbody");
		for (const { ref, issue } of items) {
			const isClosed = issue.state === "closed";
			const inProgress =
				!isClosed && isInProgress(issue, this.settings.inProgressLabel);
			const status = isClosed
				? "closed"
				: inProgress
					? "in-progress"
					: "open";
			const label = inProgress ? "in progress" : status;

			const row = body.createEl("tr", { cls: "gitea-search-table__row" });
			if (isClosed) {
				row.addClass("gitea-search-table__row--closed");
			}
			const accent = this.settings.repoAccents[`${ref.owner}/${ref.repo}`];
			if (accent) {
				row.addClass("gitea-search-table__row--accented");
				row.style.setProperty("--gitea-accent", accent);
			}

			// State dot.
			const dotCell = row.createEl("td", {
				cls: "gitea-search-table__cell gitea-search-table__cell--dot",
			});
			dotCell.createSpan({
				cls: `gitea-search-table__dot gitea-search-table__dot--${status}`,
			});

			// Linked issue number.
			const numCell = row.createEl("td", {
				cls: "gitea-search-table__cell gitea-search-table__cell--number",
			});
			const link = numCell.createEl("a", {
				cls: "gitea-search-table__number",
				text: `#${issue.number}`,
				href: buildIssueUrl(this.settings.baseUrl, ref),
			});
			link.setAttr("target", "_blank");
			link.setAttr("rel", "noopener");

			// Optional owner/repo column for cross-repo results.
			if (showRepo) {
				row.createEl("td", {
					cls: "gitea-search-table__cell gitea-search-table__cell--repo",
					text: `${ref.owner}/${ref.repo}`,
				});
			}

			// Title.
			row.createEl("td", {
				cls: "gitea-search-table__cell gitea-search-table__cell--title",
				text: issue.title,
			});

			// Status badge.
			const stateCell = row.createEl("td", {
				cls: "gitea-search-table__cell gitea-search-table__cell--state",
			});
			stateCell.createSpan({
				cls: `gitea-search-table__state gitea-search-table__state--${status}`,
				text: label,
			});
		}
	}

	/**
	 * Render a milestone load result into `el`, replacing whatever was there.
	 * Renders the progress block (greyed out with a stale badge when serving
	 * last-known data) or, when nothing has ever loaded, a one-line error.
	 */
	renderMilestoneResult(
		el: HTMLElement,
		query: MilestoneQuery,
		result: CacheLoadResult<GiteaMilestoneDetail>
	): void {
		el.empty();
		if (!result.value) {
			this.renderError(
				el,
				result.error?.message ?? "Failed to load milestone."
			);
			return;
		}
		this.renderMilestoneCard(el, query, result.value, result.stale);
	}

	private renderMilestoneCard(
		el: HTMLElement,
		query: MilestoneQuery,
		milestone: GiteaMilestoneDetail,
		stale = false
	): void {
		const open = milestone.open_issues ?? 0;
		const closed = milestone.closed_issues ?? 0;
		const total = open + closed;
		const percent = milestoneProgressPercent(open, closed);
		const isClosed = milestone.state === "closed";

		const card = el.createDiv({ cls: "gitea-card gitea-milestone" });
		this.applyRepoAccent(card, query.repo);
		if (isClosed) {
			card.addClass("gitea-card--closed");
		}
		if (stale) {
			card.addClass("gitea-card--stale");
		}

		// Header — milestone title (linked) + completion percentage.
		const header = card.createDiv({ cls: "gitea-milestone__header" });
		const link = header.createEl("a", {
			cls: "gitea-milestone__title",
			text: milestone.title,
			href: buildMilestoneUrl(this.settings.baseUrl, query.repo, milestone.id),
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");

		if (stale) {
			const badge = header.createSpan({
				cls: "gitea-card__stale-badge",
				text: "stale",
			});
			badge.setAttr(
				"aria-label",
				"Showing last-known data — Gitea is currently unreachable"
			);
		}

		header.createSpan({
			cls: "gitea-milestone__percent",
			text: `${percent}%`,
		});

		// Progress bar — width comes from a CSS custom property (no inline style
		// rules; the static rules live in styles.css), mirroring the label chips.
		const track = card.createDiv({ cls: "gitea-milestone__bar" });
		track.setAttr("role", "progressbar");
		track.setAttr("aria-valuemin", "0");
		track.setAttr("aria-valuemax", "100");
		track.setAttr("aria-valuenow", String(percent));
		const fill = track.createDiv({ cls: "gitea-milestone__bar-fill" });
		fill.style.setProperty("--gitea-progress", `${percent}%`);

		// Stats — closed-of-total and the remaining open count.
		const stats = card.createDiv({ cls: "gitea-milestone__stats" });
		stats.createSpan({
			cls: "gitea-milestone__stat",
			text:
				total === 0
					? "No issues in this milestone"
					: `${closed} of ${total} closed`,
		});
		if (open > 0) {
			stats.createSpan({
				cls: "gitea-milestone__stat",
				text: `${open} open`,
			});
		}
	}

	/**
	 * Render a graph load result into `el`, replacing whatever was there. Renders
	 * the DAG (greyed out with a stale badge when serving last-known data) or, when
	 * nothing has ever loaded, a one-line error.
	 */
	renderGraphResult(
		el: HTMLElement,
		query: GraphQuery,
		result: CacheLoadResult<GraphData>,
		onRefresh?: () => void
	): void {
		el.empty();
		if (!result.value) {
			this.renderError(el, result.error?.message ?? "Failed to load graph.");
			return;
		}
		this.renderGraph(el, query, result.value, result.stale, onRefresh);
	}

	/**
	 * Render a dependency DAG as an SVG of linked nodes and blocker → dependent
	 * edges. Nodes are laid out in longest-path layers (see {@link
	 * assignGraphLayers}) along the chosen direction; each is an SVG anchor opening
	 * the issue in Gitea (configured base URL, never the API host). Colour and the
	 * status dot reflect state, mirroring the cards/chips; a still-blocked open
	 * issue is dimmed with a dashed outline so the currently-unblocked work — what
	 * the issue processor picks up next — stands out. All styling lives in
	 * styles.css (CSS classes + Obsidian variables); the SVG sets only geometry.
	 */
	private renderGraph(
		el: HTMLElement,
		query: GraphQuery,
		data: GraphData,
		stale = false,
		onRefresh?: () => void
	): void {
		const wrapper = el.createDiv({ cls: "gitea-card gitea-graph" });
		if (stale) {
			wrapper.addClass("gitea-card--stale");
			const badge = wrapper.createSpan({
				cls: "gitea-card__stale-badge gitea-graph__stale-badge",
				text: "stale",
			});
			badge.setAttr(
				"aria-label",
				"Showing last-known data — Gitea is currently unreachable"
			);
		}

		// A "Refresh" button that forces a fresh fetch on demand (issue #42),
		// pinned to the block's bottom-right corner (issue #45).
		if (onRefresh) {
			this.renderCornerRefresh(wrapper, "Refresh graph now", onRefresh);
		}

		// Header — the scope this graph renders (repo + milestone) on the left, so
		// a note with several graphs reads clearly without inspecting each block
		// (#41).
		const header = wrapper.createDiv({ cls: "gitea-graph__header" });
		const heading = header.createDiv({ cls: "gitea-graph__heading" });

		// The repo this graph is scoped to (the configured default when the block
		// omits one) — null for a global cross-repo set, which has no repo to link.
		const repoSlug =
			query.repo ??
			(this.settings.defaultRepo.length > 0 ? this.settings.defaultRepo : null);
		const parsedRepo = repoSlug ? splitRepo(repoSlug) : null;
		const titleText = graphTitle(query, this.settings.defaultRepo);
		// Title links to the repo on Gitea (issue #47); a global graph stays plain.
		if (parsedRepo) {
			const titleLink = heading.createEl("a", {
				cls: "gitea-graph__title",
				text: titleText,
				href: buildRepoUrl(
					this.settings.baseUrl,
					parsedRepo.owner,
					parsedRepo.repo
				),
			});
			titleLink.setAttr("target", "_blank");
			titleLink.setAttr("rel", "noopener");
		} else {
			heading.createDiv({ cls: "gitea-graph__title", text: titleText });
		}

		// Subtitle — each scoped milestone, linked to its Gitea page when its id is
		// known (gathered from the scoped issues) and a repo is in scope (issue #47).
		if (query.milestones.length > 0) {
			const subtitle = heading.createDiv({ cls: "gitea-graph__subtitle" });
			const label =
				query.milestones.length === 1 ? "milestone" : "milestones";
			subtitle.createSpan({ text: `${label} ` });
			query.milestones.forEach((name, i) => {
				if (i > 0) {
					subtitle.createSpan({ text: ", " });
				}
				const milestoneId = data.milestoneIds?.[name];
				if (repoSlug && typeof milestoneId === "number") {
					const link = subtitle.createEl("a", {
						cls: "gitea-graph__milestone-link",
						text: name,
						href: buildMilestoneUrl(
							this.settings.baseUrl,
							repoSlug,
							milestoneId
						),
					});
					link.setAttr("target", "_blank");
					link.setAttr("rel", "noopener");
				} else {
					subtitle.createSpan({ text: name });
				}
			});
		}

		if (data.nodes.length === 0) {
			wrapper.addClass("gitea-card--empty");
			wrapper.createSpan({ text: "No issues match this query." });
			return;
		}

		// Geometry (px). The SVG is scaled to fit the note width by CSS, so these
		// are the intrinsic coordinates, not on-screen sizes.
		const NODE_W = 200;
		const NODE_H = 48;
		const GAP_MAIN = 60; // between layers (along the flow direction)
		const GAP_CROSS = 18; // between siblings within a layer
		const PAD = 10;
		const isLR = query.direction === "LR";

		const layers = assignGraphLayers(data.nodes, data.edges);
		const byLayer = new Map<number, GraphNode[]>();
		let maxLayer = 0;
		for (const node of data.nodes) {
			const layer = layers.get(node.id) ?? 0;
			maxLayer = Math.max(maxLayer, layer);
			const group = byLayer.get(layer);
			if (group) {
				group.push(node);
			} else {
				byLayer.set(layer, [node]);
			}
		}

		// Position each node: layer drives the main axis, sibling index the cross.
		const pos = new Map<string, { x: number; y: number }>();
		let maxCross = 1;
		for (let layer = 0; layer <= maxLayer; layer++) {
			const group = byLayer.get(layer) ?? [];
			maxCross = Math.max(maxCross, group.length);
			group.forEach((node, i) => {
				const main = PAD + layer * ((isLR ? NODE_W : NODE_H) + GAP_MAIN);
				const cross = PAD + i * ((isLR ? NODE_H : NODE_W) + GAP_CROSS);
				pos.set(node.id, {
					x: isLR ? main : cross,
					y: isLR ? cross : main,
				});
			});
		}

		const mainSpan =
			PAD * 2 + (maxLayer + 1) * (isLR ? NODE_W : NODE_H) + maxLayer * GAP_MAIN;
		const crossSpan =
			PAD * 2 + maxCross * (isLR ? NODE_H : NODE_W) + (maxCross - 1) * GAP_CROSS;
		const width = isLR ? mainSpan : crossSpan;
		const height = isLR ? crossSpan : mainSpan;

		const svg = wrapper.createSvg("svg", {
			cls: "gitea-graph__svg",
			attr: {
				viewBox: `0 0 ${width} ${height}`,
				width,
				height,
				preserveAspectRatio: "xMinYMin meet",
				role: "img",
				"aria-label": `Dependency graph of ${data.nodes.length} issues`,
			},
		});

		// Arrowhead marker — unique id per render so concurrent graphs never share
		// (and clobber) one another's marker definition.
		const markerId = `gitea-graph-arrow-${graphRenderSeq++}`;
		const marker = svg
			.createSvg("defs")
			.createSvg("marker", {
				attr: {
					id: markerId,
					markerWidth: 8,
					markerHeight: 8,
					refX: 7,
					refY: 3,
					orient: "auto",
					markerUnits: "strokeWidth",
				},
			});
		marker.createSvg("path", {
			cls: "gitea-graph__arrow",
			attr: { d: "M0,0 L7,3 L0,6 Z" },
		});

		// Edges first, so nodes paint on top of them.
		for (const edge of data.edges) {
			const from = pos.get(edge.from);
			const to = pos.get(edge.to);
			if (!from || !to) {
				continue;
			}
			let d: string;
			if (isLR) {
				const x1 = from.x + NODE_W;
				const y1 = from.y + NODE_H / 2;
				const x2 = to.x;
				const y2 = to.y + NODE_H / 2;
				const mx = (x1 + x2) / 2;
				d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
			} else {
				const x1 = from.x + NODE_W / 2;
				const y1 = from.y + NODE_H;
				const x2 = to.x + NODE_W / 2;
				const y2 = to.y;
				const my = (y1 + y2) / 2;
				d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
			}
			svg.createSvg("path", {
				cls: "gitea-graph__edge",
				attr: { d, "marker-end": `url(#${markerId})` },
			});
		}

		// Nodes — each an SVG anchor opening the issue in Gitea.
		for (const node of data.nodes) {
			const point = pos.get(node.id);
			if (!point) {
				continue;
			}
			const status = node.state === "closed"
				? "closed"
				: node.inProgress
					? "in-progress"
					: "open";
			const classes = [
				"gitea-graph__node",
				`gitea-graph__node--${status}`,
			];
			if (node.blocked) {
				classes.push("gitea-graph__node--blocked");
			}
			const anchor = svg.createSvg("a", {
				cls: classes,
				attr: {
					href: buildIssueUrl(this.settings.baseUrl, node.ref),
					target: "_blank",
					rel: "noopener",
				},
			});
			// Native SVG tooltip with the full (un-truncated) title.
			anchor.createSvg("title").textContent = `#${node.number} ${node.title}`;
			const group = anchor.createSvg("g", {
				attr: { transform: `translate(${point.x},${point.y})` },
			});
			group.createSvg("rect", {
				cls: "gitea-graph__node-rect",
				attr: { x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 6, ry: 6 },
			});
			// `cls` must be an array, not a space-joined string: Obsidian's
			// `createSvg` applies a string `cls` via `classList.add(cls)`, which
			// throws on a multi-class token (spaces are invalid in a DOM token).
			// That throw would abort the rest of this node *and* every later one,
			// leaving bare rectangles — pass each class separately instead.
			group.createSvg("circle", {
				cls: ["gitea-graph__node-dot", `gitea-graph__node-dot--${status}`],
				attr: { cx: 16, cy: NODE_H / 2, r: 5 },
			});
			group.createSvg("text", {
				cls: "gitea-graph__node-number",
				attr: { x: 30, y: 20 },
			}).textContent = `#${node.number}`;
			group.createSvg("text", {
				cls: "gitea-graph__node-title",
				attr: { x: 30, y: 36 },
			}).textContent = truncate(node.title, 24);
		}
	}

	/**
	 * Walk the rendered inline-code spans of `el` and turn any whose content is a
	 * single completed reference into a chip. Only a backtick-wrapped reference
	 * (an inline `<code>` element) becomes a chip — a bare reference in prose is
	 * left alone (issue #14). Fenced code blocks render as `<pre><code>` and are
	 * skipped, so a reference inside one stays literal. Runs on every rendered
	 * block, so it bails cheaply on spans that do not even contain the keyword.
	 */
	processInlineChips(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		const keyword = this.settings.keyword;
		if (!keyword) {
			return;
		}
		const marker = `${keyword}:`;
		const pattern = inlineChipReferencePattern(keyword);
		// `findAll` returns a static array, so replacing elements as we go is safe.
		for (const code of el.findAll("code")) {
			if (code.closest("pre, a, .gitea-chip")) {
				continue;
			}
			const text = (code.textContent ?? "").trim();
			if (!text.includes(marker)) {
				continue;
			}
			const match = pattern.exec(text);
			if (!match) {
				continue;
			}
			const ref: IssueRef = {
				owner: match[1],
				repo: match[2],
				index: Number.parseInt(match[3], 10),
			};
			code.replaceWith(this.createInlineChip(ref, ctx));
		}
	}

	/**
	 * Build one inline chip — `#123 ●` linked to the issue — and attach a
	 * {@link InlineChipChild} that lazily fills the title (hover preview) and
	 * colours the state dot from the shared cache.
	 */
	private createInlineChip(
		ref: IssueRef,
		ctx: MarkdownPostProcessorContext
	): HTMLAnchorElement {
		const chip = createChipElement(
			this.settings.baseUrl,
			ref,
			this.settings.repoAccents[`${ref.owner}/${ref.repo}`]
		);
		ctx.addChild(new InlineChipChild(chip, this, ref));
		return chip;
	}

	private renderError(el: HTMLElement, message: string): void {
		const card = el.createDiv({ cls: "gitea-card gitea-card--error" });
		card.createSpan({ cls: "gitea-card__error", text: message });
	}

	/**
	 * Tint a card's left border with the configured accent colour for its repo,
	 * if one is set (issue #19). Keyed by `owner/repo`; the colour is fed to the
	 * static CSS rule via a `--gitea-accent` custom property — the same
	 * data-driven pattern the label chips use — so no inline style rule is hard
	 * coded. A repo without an entry is left with the default neutral border.
	 */
	private applyRepoAccent(card: HTMLElement, repo: string): void {
		const accent = this.settings.repoAccents[repo];
		if (accent) {
			card.addClass("gitea-card--accented");
			card.style.setProperty("--gitea-accent", accent);
		}
	}

	private renderIssueCard(
		el: HTMLElement,
		ref: IssueRef,
		issue: GiteaIssue,
		stale = false,
		actions?: CardActions,
		commentPreview?: CommentPreviewOptions
	): void {
		const isClosed = issue.state === "closed";
		const card = el.createDiv({ cls: "gitea-card" });
		this.applyRepoAccent(card, `${ref.owner}/${ref.repo}`);
		if (isClosed) {
			card.addClass("gitea-card--closed");
		}
		if (stale) {
			card.addClass("gitea-card--stale");
		}

		// Line 1 — issue number (linked) and title. The repo is named on the
		// status line for every card (issue #22), so it is not repeated here.
		const header = card.createDiv({ cls: "gitea-card__header" });
		const link = header.createEl("a", {
			cls: "gitea-card__number",
			text: `#${issue.number}`,
			href: buildIssueUrl(this.settings.baseUrl, ref),
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");
		header.createSpan({ cls: "gitea-card__title", text: issue.title });

		// A stale card is last-known data shown because Gitea is unreachable.
		if (stale) {
			const badge = header.createSpan({
				cls: "gitea-card__stale-badge",
				text: "stale",
			});
			badge.setAttr(
				"aria-label",
				"Showing last-known data — Gitea is currently unreachable"
			);
		}

		// Line 2 — first body line, markdown-stripped and truncated.
		const body = truncate(
			stripMarkdown(issue.body ?? ""),
			this.settings.truncationLength
		);
		if (body) {
			card.createDiv({ cls: "gitea-card__body", text: body });
		}

		// Attachment strip (issue #54) — image thumbnails + file chips under the
		// body, behind the default-off "show attachments" setting. Gated on
		// `commentPreview`, which only the single-issue card supplies (search and
		// milestone list cards pass none), so list blocks never spend the extra
		// `…/assets` GET; skipped on a stale offline card, where the call would
		// only fail. The strip container is created synchronously to hold its place
		// above the meta row, then filled — or removed when empty — once assets load.
		if (commentPreview && this.settings.showAttachments && !stale) {
			const strip = card.createDiv({ cls: "gitea-card__attachments" });
			void this.renderAttachmentStrip(strip, ref, commentPreview.component);
		}

		// Line 3 — label chips, author, milestone.
		const meta = card.createDiv({ cls: "gitea-card__meta" });
		if (issue.labels?.length) {
			const labels = meta.createDiv({ cls: "gitea-card__labels" });
			for (const label of issue.labels) {
				const blockerIndex = parseBlockedByLabel(label.name);
				if (blockerIndex === null) {
					const chip = labels.createSpan({
						cls: "gitea-card__label",
						text: label.name,
					});
					// Dynamic per-label colour from the API; the static rules live
					// in styles.css and read these custom properties.
					chip.style.setProperty("--gitea-label-bg", `#${label.color}`);
					chip.style.setProperty(
						"--gitea-label-fg",
						labelTextColor(label.color)
					);
					continue;
				}
				// A blocked-by:#N dependency — highlight it (CSS class, not the
				// API colour) and resolve the blocker's state from the shared
				// cache so a closed (cleared) blocker is visible at a glance.
				const chip = labels.createSpan({
					cls: "gitea-card__label gitea-card__label--blocked-by",
				});
				// Show the human-readable form (sentence case, matching the
				// aria-label) rather than the raw `blocked-by:#N` slug, which is a
				// machine convention not meant for the card surface.
				chip.createSpan({
					cls: "gitea-card__label-name",
					text: `Blocked by #${blockerIndex}`,
				});
				void this.renderBlockerState(chip, {
					owner: ref.owner,
					repo: ref.repo,
					index: blockerIndex,
				});
			}
		}
		const author = meta.createDiv({ cls: "gitea-card__author" });
		author.createSpan({
			cls: "gitea-card__avatar",
			text: initialsFromLogin(issue.user.login),
		});
		author.createSpan({
			cls: "gitea-card__author-name",
			text: issue.user.login,
		});
		if (issue.milestone) {
			const milestone = meta.createDiv({ cls: "gitea-card__milestone" });
			milestone.createSpan({
				cls: "gitea-card__milestone-icon",
				text: "🎯",
			});
			milestone.createSpan({ text: issue.milestone.title });
		}

		// Line 4 — repo, comment count, state dot, relative updated time.
		const status = card.createDiv({ cls: "gitea-card__status" });

		// Repo identity, in the front (issue #22): every card now names the repo
		// it belongs to, linked to the repo page. Built from the configured base
		// URL, never the API host (the ROOT_URL caveat).
		const repoEl = status.createEl("a", {
			cls: "gitea-card__repo-name",
			href: buildRepoUrl(this.settings.baseUrl, ref.owner, ref.repo),
		});
		repoEl.setAttr("target", "_blank");
		repoEl.setAttr("rel", "noopener");
		repoEl.setAttr("aria-label", `Repository ${ref.owner}/${ref.repo}`);
		repoEl.createSpan({ cls: "gitea-card__repo-icon", text: "📦" });
		repoEl.createSpan({ text: `${ref.owner}/${ref.repo}` });

		// The comment count is plain text by default, but on a single-issue card
		// with at least one comment it becomes a toggle that expands a thread
		// preview inline (issue #40). The thread is fetched lazily — only while
		// expanded — through the shared comments cache.
		const canExpandComments =
			commentPreview !== undefined && issue.comments > 0;
		if (canExpandComments) {
			const toggle = status.createEl("button", {
				cls: "gitea-card__comments gitea-card__comments--toggle",
			});
			toggle.setAttr("aria-expanded", String(commentPreview.expanded));
			toggle.setAttr(
				"aria-label",
				commentPreview.expanded
					? "Hide comments"
					: "Show recent comments"
			);
			toggle.createSpan({ cls: "gitea-card__comments-icon", text: "💬" });
			toggle.createSpan({ text: String(issue.comments) });
			toggle.createSpan({
				cls: "gitea-card__comments-caret",
				text: commentPreview.expanded ? "▾" : "▸",
			});
			toggle.addEventListener("click", () => commentPreview.onToggle());
		} else {
			const comments = status.createSpan({ cls: "gitea-card__comments" });
			comments.createSpan({ cls: "gitea-card__comments-icon", text: "💬" });
			comments.createSpan({ text: String(issue.comments) });
		}

		const state = status.createSpan({ cls: "gitea-card__state" });
		state.createSpan({
			cls: isClosed
				? "gitea-card__dot gitea-card__dot--closed"
				: "gitea-card__dot gitea-card__dot--open",
		});
		state.createSpan({ text: isClosed ? "closed" : "open" });

		const updated = formatRelativeTime(issue.updated_at);
		if (updated) {
			const updatedEl = status.createSpan({ cls: "gitea-card__updated" });
			updatedEl.createSpan({ cls: "gitea-card__updated-icon", text: "⟳" });
			updatedEl.createSpan({ text: `updated ${updated}` });
		}

		// Expanded comment-thread preview (issue #40) — rendered between the status
		// line and the action bar. Fetched lazily here (only while expanded) via
		// the shared comments cache, so it refreshes on the card's cadence and
		// degrades to last-known comments offline like everything else.
		if (canExpandComments && commentPreview.expanded) {
			const thread = card.createDiv({ cls: "gitea-card__comments-thread" });
			void this.renderCommentThread(thread, ref, commentPreview);
		}

		// Line 5 (single-issue card only) — quick actions. Refresh is always
		// offered (it just re-fetches, so it needs no write scope and works even
		// offline to retry); the write-gated actions are revealed once the
		// per-repo write probe confirms the token can edit issues (F7), and are
		// skipped on a stale card where they would only fail.
		if (actions) {
			const actionsEl = card.createDiv({ cls: "gitea-card__actions" });
			this.renderRefreshAction(actionsEl, actions);
			if (!stale) {
				void this.renderQuickActions(actionsEl, ref, issue, actions);
			}
		}
	}

	/**
	 * Load and render the most recent comments into an expanded thread preview
	 * (issue #40). Pulls from {@link commentsCache} (same throttle/backoff/stale
	 * lifecycle as the cards), shows a stale notice when serving last-known data
	 * offline, and a one-line message when the load fails or the thread is empty.
	 * The newest `count` comments are shown, oldest-first within that slice; a
	 * count chip notes when older comments are hidden.
	 */
	private async renderCommentThread(
		container: HTMLElement,
		ref: IssueRef,
		preview: CommentPreviewOptions
	): Promise<void> {
		container.createDiv({
			cls: "gitea-card__comments-loading",
			text: "Loading comments…",
		});
		const result = await this.commentsCache.load(ref, this.refreshIntervalMs);
		// The card may have been torn down (or collapsed) while in flight.
		if (!container.isConnected) {
			return;
		}
		container.empty();

		const all = result.value;
		if (!all) {
			container.createDiv({
				cls: "gitea-card__comments-message",
				text: result.error?.message ?? "Failed to load comments.",
			});
			return;
		}
		if (result.stale) {
			container.createDiv({
				cls: "gitea-card__comments-message",
				text: "Gitea is unreachable — showing last-known comments.",
			});
		}
		if (all.length === 0) {
			container.createDiv({
				cls: "gitea-card__comments-message",
				text: "No comments yet.",
			});
			return;
		}

		const recent = preview.count > 0 ? all.slice(-preview.count) : all;
		if (all.length > recent.length) {
			container.createDiv({
				cls: "gitea-card__comments-message",
				text: `Showing the latest ${recent.length} of ${all.length} comments.`,
			});
		}
		for (const comment of recent) {
			this.renderComment(container, comment, preview);
		}
	}

	/**
	 * Render one comment in an expanded thread (issue #40): an avatar + author +
	 * relative timestamp header, then the comment body rendered as Markdown (Gitea
	 * comment bodies are Markdown). The Markdown render attaches to the card's
	 * render child so its embeds are torn down with the card.
	 */
	private renderComment(
		container: HTMLElement,
		comment: GiteaComment,
		preview: CommentPreviewOptions
	): void {
		const el = container.createDiv({ cls: "gitea-card__comment" });
		const header = el.createDiv({ cls: "gitea-card__comment-header" });
		header.createSpan({
			cls: "gitea-card__avatar",
			text: initialsFromLogin(comment.user.login),
		});
		header.createSpan({
			cls: "gitea-card__comment-author",
			text: comment.user.login,
		});
		const when = formatRelativeTime(comment.created_at);
		if (when) {
			header.createSpan({ cls: "gitea-card__comment-time", text: when });
		}
		const body = el.createDiv({ cls: "gitea-card__comment-body" });
		void this.renderCommentBody(body, comment.body ?? "", preview);
	}

	/**
	 * Markdown-render one comment body, then (issue #53) run the post-render image
	 * pass so screenshots pasted into Gitea comments actually appear. Gitea writes
	 * attachments as root-relative `/attachments/<uuid>` and a plain `<img src>`
	 * can't carry our auth headers, so the native render leaves them broken. We
	 * await the render, then rewrite each of *our* images to a token-authed object
	 * URL via {@link loadAuthedImage}. Gated by {@link
	 * GiteaCardsSettings.showCommentImages} (default off): when off the comment
	 * renders exactly as before, no image fetch.
	 */
	private async renderCommentBody(
		body: HTMLElement,
		source: string,
		preview: CommentPreviewOptions
	): Promise<void> {
		await MarkdownRenderer.render(
			this.app,
			source,
			body,
			preview.sourcePath,
			preview.component
		);
		if (!this.settings.showCommentImages || !body.isConnected) {
			return;
		}
		const images = body.querySelectorAll("img");
		for (let i = 0; i < images.length; i++) {
			const img = images[i];
			const resolved = resolveImageSrc(
				this.settings.baseUrl,
				img.getAttribute("src") ?? ""
			);
			// Only proxy images on our Gitea; leave foreign/`data:`/`blob:` srcs to
			// the plain `<img>` that already loaded them unauthenticated.
			if (resolved.authed) {
				this.loadCommentImage(img, resolved.url, preview.component);
			}
		}
	}

	/**
	 * Swap one comment `<img>` from its broken native (root-relative / wrong-host)
	 * src to a token-authed object URL (issue #53). Blanks the native src so the
	 * unauthenticated request is dropped, shows a loading placeholder, then on load
	 * sets the object URL and wires click → {@link ImageLightboxModal}. On failure
	 * (CF-Access reject / token invalid) it replaces the image with a small "🔒"
	 * placeholder carrying the auth-taxonomy message rather than a broken icon.
	 */
	private loadCommentImage(
		img: HTMLImageElement,
		url: string,
		component: MarkdownRenderChild
	): void {
		const alt = img.getAttribute("alt") ?? "";
		img.removeAttribute("src");
		img.addClass("gitea-card__comment-image");
		img.addClass("gitea-card__comment-image--loading");
		this.loadAuthedImage(url, component)
			.then((objectUrl) => {
				if (!img.isConnected) {
					return;
				}
				img.setAttr("src", objectUrl);
				img.removeClass("gitea-card__comment-image--loading");
				img.addClass("gitea-card__comment-image--loaded");
				img.setAttr("aria-label", alt ? `View image: ${alt}` : "View image");
				component.registerDomEvent(img, "click", () => {
					new ImageLightboxModal(this, url, alt).open();
				});
			})
			.catch((error: unknown) => {
				if (!img.isConnected) {
					return;
				}
				const message =
					error instanceof Error
						? error.message
						: "Image could not be loaded.";
				img.replaceWith(
					createSpan({
						cls: "gitea-card__comment-image-error",
						text: `🔒 ${message}`,
					})
				);
			});
	}

	/**
	 * Load and render a single-issue card's attachment strip (issue #54). Pulls the
	 * asset list from {@link assetsCache} (same throttle/backoff/stale lifecycle as
	 * the card), then lays out image assets as small token-authed thumbnails and
	 * everything else as `📎 filename` download chips. An issue with no attachments
	 * — the common case — removes the empty strip so it adds no stray spacing, as
	 * does an offline load with nothing cached. `component` owns the thumbnails'
	 * object URLs and click handlers so they are revoked/torn down with the card.
	 */
	private async renderAttachmentStrip(
		strip: HTMLElement,
		ref: IssueRef,
		component: Component
	): Promise<void> {
		const result = await this.assetsCache.load(ref, this.refreshIntervalMs);
		// The card may have been torn down (or rebuilt) while in flight.
		if (!strip.isConnected) {
			return;
		}
		const assets = result.value ?? [];
		if (assets.length === 0) {
			strip.remove();
			return;
		}
		for (const asset of assets) {
			// Rewrite the asset URL onto the configured base — its
			// browser_download_url carries Gitea's ROOT_URL host (often the LAN IP),
			// same caveat the issue/comment images honour.
			const resolved = resolveImageSrc(
				this.settings.baseUrl,
				asset.browser_download_url
			);
			if (isImageAsset(asset.name)) {
				this.renderAttachmentThumbnail(
					strip,
					asset,
					resolved.url,
					component
				);
			} else {
				this.renderAttachmentFileChip(strip, asset, resolved.url);
			}
		}
	}

	/**
	 * Render one image attachment as a token-authed thumbnail (issue #54). Like the
	 * comment images (I2) the bytes are fetched through {@link loadAuthedImage} —
	 * a plain `<img src>` can't carry the auth headers — and the click opens the
	 * shared in-app {@link ImageLightboxModal}. A fetch the token can't satisfy
	 * (CF-Access reject / invalid token) collapses to a small "🔒" placeholder
	 * carrying the auth-taxonomy message rather than a broken-image icon.
	 */
	private renderAttachmentThumbnail(
		strip: HTMLElement,
		asset: GiteaAsset,
		url: string,
		component: Component
	): void {
		const img = strip.createEl("img", {
			cls: "gitea-card__attachment-thumb gitea-card__attachment-thumb--loading",
		});
		img.setAttr("alt", asset.name);
		this.loadAuthedImage(url, component)
			.then((objectUrl) => {
				if (!img.isConnected) {
					return;
				}
				img.setAttr("src", objectUrl);
				img.removeClass("gitea-card__attachment-thumb--loading");
				img.addClass("gitea-card__attachment-thumb--loaded");
				img.setAttr("aria-label", `View image: ${asset.name}`);
				component.registerDomEvent(img, "click", () => {
					new ImageLightboxModal(this, url, asset.name).open();
				});
			})
			.catch((error: unknown) => {
				if (!img.isConnected) {
					return;
				}
				const message =
					error instanceof Error
						? error.message
						: "Image could not be loaded.";
				img.replaceWith(
					createSpan({
						cls: "gitea-card__attachment-error",
						text: `🔒 ${message}`,
					})
				);
			});
	}

	/**
	 * Render one non-image attachment as a `📎 filename` download chip (issue #54).
	 * The chip links to the asset on the configured base host, opened in the system
	 * browser — where the user's own session (cookies / interactive Cloudflare
	 * Access) authenticates the download, unlike the plugin's header-less `<img>`.
	 */
	private renderAttachmentFileChip(
		strip: HTMLElement,
		asset: GiteaAsset,
		url: string
	): void {
		const chip = strip.createEl("a", {
			cls: "gitea-card__attachment-file",
			href: url,
		});
		chip.setAttr("target", "_blank");
		chip.setAttr("rel", "noopener");
		chip.setAttr("aria-label", `Download ${asset.name}`);
		chip.createSpan({ cls: "gitea-card__attachment-file-icon", text: "📎" });
		chip.createSpan({
			cls: "gitea-card__attachment-file-name",
			text: asset.name,
		});
	}

	/**
	 * Resolve a `blocked-by:#N` chip's blocker state from the shared cache (F2)
	 * and reflect it inline: a state dot (red while the blocker is still open and
	 * blocking, green once it has closed) plus a `--resolved` modifier on a closed
	 * blocker. Loads through the same cache the cards use, so a blocker is fetched
	 * at most once per interval however many cards depend on it. A neutral dot is
	 * shown immediately and recoloured when the load resolves; failures leave it
	 * neutral rather than erroring.
	 */
	private async renderBlockerState(
		chip: HTMLElement,
		blockerRef: IssueRef
	): Promise<void> {
		const dot = chip.createSpan({ cls: "gitea-card__blocker-dot" });
		chip.setAttr("aria-label", `Blocked by #${blockerRef.index}`);
		const result = await this.cache.load(blockerRef, this.refreshIntervalMs);
		// The card may have been torn down while the blocker was in flight.
		if (!chip.isConnected) {
			return;
		}
		const blocker = result.value;
		if (!blocker) {
			return;
		}
		const resolved = blocker.state === "closed";
		dot.addClass(
			resolved
				? "gitea-card__blocker-dot--closed"
				: "gitea-card__blocker-dot--open"
		);
		if (resolved) {
			chip.addClass("gitea-card__label--resolved");
		}
		chip.setAttr(
			"aria-label",
			`Blocked by #${blockerRef.index} — ${resolved ? "closed" : "still open"}`
		);
	}

	/**
	 * Render the one manual-refresh control shared by the single-issue card, the
	 * search toolbar, and the graph header (issue #45). All three use the same
	 * small, subtle ghost icon (Obsidian's `clickable-icon`, matching the
	 * settings-tab refresh buttons) so "refresh now" reads identically and stays
	 * out of the way until hovered, rather than the earlier mix of a filled icon
	 * button and a text "Refresh" button. Clicking spins the icon (issue #45) for
	 * the duration of the in-flight fetch, which ends when the refreshed block
	 * tears this button down and renders a fresh one.
	 */
	private renderRefreshButton(
		container: HTMLElement,
		tooltip: string,
		onClick: () => void
	): ExtraButtonComponent {
		const button = new ExtraButtonComponent(container)
			.setIcon("refresh-cw")
			.setTooltip(tooltip)
			.onClick(() => {
				button.extraSettingsEl.addClass("gitea-refresh-button--spinning");
				onClick();
			});
		button.extraSettingsEl.addClass("gitea-refresh-button");
		return button;
	}

	/**
	 * Render a manual refresh control pinned to the bottom-right corner of a block
	 * (issue #45) — the placement shared by the search results and the graph so
	 * every "refresh now" affordance lives in the same out-of-the-way spot. The
	 * host element must be a positioning context (`position: relative`).
	 */
	private renderCornerRefresh(
		host: HTMLElement,
		tooltip: string,
		onRefresh: () => void
	): void {
		const button = this.renderRefreshButton(host, tooltip, () => onRefresh());
		button.extraSettingsEl.addClass("gitea-refresh-button--corner");
	}

	/**
	 * Add the manual refresh button to a single-issue card's action bar. Clicking
	 * it drops this issue's cache entry and re-fetches via `actions.onChanged` —
	 * the same path a successful edit takes — so it bypasses the freshness window
	 * and any active backoff, giving an instant on-demand refresh. Unlike the
	 * write-gated actions it needs no probe and is shown on every single-issue
	 * card (including a stale one, where it doubles as a retry).
	 */
	private renderRefreshAction(
		container: HTMLElement,
		actions: CardActions
	): void {
		const button = this.renderRefreshButton(
			container,
			"Refresh this card now",
			() => {
				// onChanged invalidates the cache and rebuilds the card, which
				// tears down this button — disabling it just prevents a
				// double-click in the brief window before the rebuild.
				button.setDisabled(true);
				actions.onChanged();
			}
		);
		button.extraSettingsEl.addClass("gitea-card__action--refresh");
	}

	/**
	 * Fill the quick-actions bar for a single-issue card once the per-repo write
	 * probe resolves. Hidden (left empty) when the token can't write the repo's
	 * issues. Each action invalidates the shared cache entry and re-renders the
	 * card through `actions.onChanged`.
	 */
	private async renderQuickActions(
		container: HTMLElement,
		ref: IssueRef,
		issue: GiteaIssue,
		actions: CardActions
	): Promise<void> {
		let canWrite: boolean;
		try {
			canWrite = await this.loadCanWriteIssues(ref);
		} catch {
			canWrite = false;
		}
		// The card may have been rebuilt by a refresh while the probe was in flight.
		if (!canWrite || !container.isConnected) {
			return;
		}

		const isClosed = issue.state === "closed";

		const commentButton = container.createEl("button", {
			cls: "gitea-card__action",
			text: "Comment",
		});
		commentButton.setAttr("aria-label", "Add a comment");

		const stateButton = container.createEl("button", {
			cls: "gitea-card__action",
			text: isClosed ? "Reopen" : "Close",
		});
		stateButton.setAttr(
			"aria-label",
			isClosed ? "Reopen this issue" : "Close this issue"
		);
		stateButton.addEventListener("click", () => {
			void this.runCardAction(
				stateButton,
				() =>
					this.setIssueState(ref, isClosed ? "open" : "closed"),
				actions,
				isClosed ? "Reopened issue." : "Closed issue."
			);
		});

		const labelButton = container.createEl("button", {
			cls: "gitea-card__action",
			text: "Labels",
		});
		labelButton.setAttr("aria-label", "Add or remove labels");
		labelButton.addEventListener("click", (evt) => {
			void this.openLabelMenu(evt, ref, issue, actions);
		});

		// The comment box is built lazily under the bar and toggled by its button,
		// suspending auto-refresh while open so a tick can't discard the draft.
		const commentForm = container.createDiv({
			cls: "gitea-card__comment-form gitea-card__comment-form--hidden",
		});
		commentButton.addEventListener("click", () => {
			const hidden = commentForm.hasClass("gitea-card__comment-form--hidden");
			if (hidden) {
				this.openCommentForm(commentForm, ref, actions);
			} else {
				this.closeCommentForm(commentForm, actions);
			}
		});
	}

	/**
	 * Build the inline comment box: a textarea plus send/cancel. Suspends the
	 * card's auto-refresh while open; on send, posts the comment and re-renders.
	 * When the image setting is on (and the token can write — this form only exists
	 * inside the write-gated quick actions), an image picker and a clipboard-paste
	 * handler upload to the issue's assets and splice the markdown into the draft.
	 */
	private openCommentForm(
		form: HTMLElement,
		ref: IssueRef,
		actions: CardActions
	): void {
		form.empty();
		form.removeClass("gitea-card__comment-form--hidden");
		actions.setSuspended(true);

		const input = form.createEl("textarea", {
			cls: "gitea-card__comment-input",
		});
		input.setAttr("placeholder", "Leave a comment…");
		input.rows = 3;
		input.focus();

		const buttons = form.createDiv({ cls: "gitea-card__comment-buttons" });
		const send = buttons.createEl("button", {
			cls: "gitea-card__action mod-cta",
			text: "Send",
		});
		const cancel = buttons.createEl("button", {
			cls: "gitea-card__action",
			text: "Cancel",
		});

		// Image attach (issue #56), gated on the same default-off image setting as
		// the inbound rendering (I2) — turning it on means uploaded screenshots also
		// show inline once the comment posts and the card re-renders. The write-scope
		// gate is already handled by renderQuickActions, which builds this form.
		if (this.settings.showCommentImages) {
			const fileInput = buttons.createEl("input", {
				cls: "gitea-card__comment-file",
			});
			fileInput.type = "file";
			fileInput.accept = "image/*";
			fileInput.setAttr("aria-label", "Attach an image");
			fileInput.addEventListener("change", () => {
				const file = fileInput.files?.[0] ?? null;
				// Reset so picking the same file again still fires `change`.
				fileInput.value = "";
				if (file) {
					void this.attachCommentImage(ref, file, input, send, fileInput);
				}
			});
			// Pasting a screenshot straight into the box goes through the same path.
			input.addEventListener("paste", (evt) => {
				const item = Array.from(evt.clipboardData?.items ?? []).find(
					(entry) =>
						entry.kind === "file" && entry.type.startsWith("image/")
				);
				const file = item?.getAsFile() ?? null;
				if (file) {
					evt.preventDefault();
					void this.attachCommentImage(
						ref,
						file,
						input,
						send,
						fileInput
					);
				}
			});
		}

		cancel.addEventListener("click", () => this.closeCommentForm(form, actions));
		send.addEventListener("click", () => {
			const body = input.value.trim();
			if (!body) {
				new Notice("Enter a comment first.");
				return;
			}
			void this.runCardAction(
				send,
				() => this.addIssueComment(ref, body),
				actions,
				"Comment posted."
			);
		});
	}

	/**
	 * Upload an image to the issue's assets and splice its markdown into the comment
	 * draft (issue #56). Uploading to the *issue* (not a not-yet-existing comment)
	 * keeps it one step: the returned `![name](/attachments/{uuid})` goes in at the
	 * cursor, and the normal Send posts the comment — whose re-render then shows the
	 * image inline via I2 and refreshes the attachment strip (I3). Send and the file
	 * picker are disabled during the in-flight upload so a half-uploaded draft can't
	 * be posted; failures surface through the shared auth taxonomy as a notice.
	 */
	private async attachCommentImage(
		ref: IssueRef,
		file: File,
		input: HTMLTextAreaElement,
		sendButton: HTMLButtonElement,
		fileInput: HTMLInputElement
	): Promise<void> {
		if (!file.type.startsWith("image/")) {
			new Notice("Only images can be attached.");
			return;
		}
		const sendWasDisabled = sendButton.disabled;
		sendButton.disabled = true;
		fileInput.disabled = true;
		const progress = new Notice("Uploading image…", 0);
		try {
			const bytes = await file.arrayBuffer();
			const name =
				file.name && file.name.trim()
					? file.name
					: defaultImageName(file.type);
			const attachment = await this.uploadIssueAsset(
				ref,
				name,
				file.type,
				bytes
			);
			insertAtCursor(input, attachmentMarkdown(attachment));
			new Notice("Image attached.");
		} catch (error) {
			new Notice(
				error instanceof Error ? error.message : "Image upload failed."
			);
		} finally {
			progress.hide();
			sendButton.disabled = sendWasDisabled;
			fileInput.disabled = false;
			input.focus();
		}
	}

	/** Collapse the comment box and resume the card's auto-refresh. */
	private closeCommentForm(form: HTMLElement, actions: CardActions): void {
		form.empty();
		form.addClass("gitea-card__comment-form--hidden");
		actions.setSuspended(false);
	}

	/**
	 * Open a checkable menu of the repo's labels, ticking those already applied.
	 * Selecting one adds or removes it by ID and re-renders. The menu closes after
	 * a pick, so toggling several means reopening — kept simple on purpose.
	 */
	private async openLabelMenu(
		evt: MouseEvent,
		ref: IssueRef,
		issue: GiteaIssue,
		actions: CardActions
	): Promise<void> {
		let labels: GiteaLabel[];
		try {
			labels = await this.fetchLabels(`${ref.owner}/${ref.repo}`);
		} catch (error) {
			new Notice(
				error instanceof Error ? error.message : "Could not load labels."
			);
			return;
		}
		if (labels.length === 0) {
			new Notice("This repository has no labels.");
			return;
		}

		const applied = new Set(issue.labels?.map((label) => label.id));
		const menu = new Menu();
		for (const label of labels) {
			const isApplied = applied.has(label.id);
			menu.addItem((item) => {
				item
					.setTitle(label.name)
					.setChecked(isApplied)
					.onClick(() => {
						void this.runCardAction(
							null,
							() =>
								isApplied
									? this.removeIssueLabel(ref, label.id)
									: this.addIssueLabels(ref, [label.id]),
							actions,
							isApplied
								? `Removed “${label.name}”.`
								: `Added “${label.name}”.`
						);
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	/**
	 * Run one quick action: disable the triggering button, perform the mutation,
	 * then invalidate the cache and re-render via `onChanged`. Failures surface as
	 * a notice (e.g. a `403` from a token that probed writable but lacks the
	 * `write:issue` scope) and re-enable the button for a retry.
	 */
	private async runCardAction(
		button: HTMLButtonElement | null,
		mutate: () => Promise<void>,
		actions: CardActions,
		successMessage: string
	): Promise<void> {
		if (button) {
			button.disabled = true;
		}
		try {
			await mutate();
			new Notice(successMessage);
			// onChanged invalidates the shared cache entry and rebuilds the card,
			// which also tears down this button — no need to re-enable it.
			actions.onChanged();
		} catch (error) {
			new Notice(
				error instanceof Error ? error.message : "Action failed."
			);
			if (button) {
				button.disabled = false;
			}
		}
	}
}

/**
 * Lifecycle wrapper for one rendered card. As a MarkdownRenderChild added via
 * `ctx.addChild`, its `onload` starts the refresh timer and `onunload` (run
 * when the note scrolls off-screen, closes, or the plugin unloads) tears the
 * timer down — `registerInterval` ties the interval to this component's life.
 */
class IssueCardChild extends MarkdownRenderChild {
	/**
	 * Set while an on-card editor (the comment box) is open, so an interval tick
	 * doesn't rebuild the card and discard a half-typed comment (F7).
	 */
	private suspended = false;

	/**
	 * Whether the comment-thread preview is currently expanded (issue #40). Kept on
	 * the child so it survives the per-interval card rebuilds; seeded from the
	 * block's optional `comments:` auto-expand key.
	 */
	private commentsExpanded: boolean;

	/** How many recent comments the expanded thread shows (issue #40). */
	private readonly commentCount: number;

	constructor(
		containerEl: HTMLElement,
		private readonly plugin: GiteaCardsPlugin,
		private readonly ref: IssueRef,
		private readonly sourcePath: string,
		autoExpandComments: number | null
	) {
		super(containerEl);
		// A `comments:` block key auto-expands from the first render; its positive
		// value also overrides the configured default count (0 = use the default).
		this.commentsExpanded = autoExpandComments !== null;
		this.commentCount =
			autoExpandComments && autoExpandComments > 0
				? autoExpandComments
				: plugin.settings.commentPreviewCount;
	}

	onload(): void {
		this.containerEl.empty();
		this.containerEl.createDiv({
			cls: "gitea-card gitea-card--loading",
			text: "Loading issue…",
		});
		void this.refresh();

		// Auto-cancelled on unload (note closed/scrolled away or plugin unload).
		// Only visible cards hit the network; off-screen leaves are skipped.
		this.registerInterval(
			window.setInterval(() => {
				if (this.suspended || !isElementVisible(this.containerEl)) {
					return;
				}
				void this.refresh();
			}, this.plugin.refreshIntervalMs)
		);
	}

	/** Pull from the shared cache and rebuild the card from the result. */
	private async refresh(): Promise<void> {
		const result = await this.plugin.cache.load(
			this.ref,
			this.plugin.refreshIntervalMs
		);
		// The child may have unloaded while the request was in flight.
		if (!this.containerEl.isConnected) {
			return;
		}
		this.plugin.renderCardResult(
			this.containerEl,
			this.ref,
			result,
			{
				// A successful action invalidates this issue's cache entry and
				// rebuilds the card from a fresh fetch; the rebuild clears any open
				// editor, so refreshing is also resumed. The comments cache is
				// dropped too, so a freshly posted comment shows in the thread.
				onChanged: () => {
					this.suspended = false;
					this.plugin.cache.invalidate(this.ref);
					this.plugin.commentsCache.invalidate(this.ref);
					this.plugin.assetsCache.invalidate(this.ref);
					void this.refresh();
				},
				setSuspended: (suspended) => {
					this.suspended = suspended;
				},
			},
			{
				count: this.commentCount,
				expanded: this.commentsExpanded,
				component: this,
				sourcePath: this.sourcePath,
				// Toggling just flips the local flag and rebuilds from cache (no
				// network unless the freshness window has lapsed) — expansion state
				// is ephemeral and lives only on this child (issue #40).
				onToggle: () => {
					this.commentsExpanded = !this.commentsExpanded;
					void this.refresh();
				},
			}
		);
	}
}

/**
 * Lifecycle wrapper for one `gitea-search` block — the list-of-cards counterpart
 * to {@link IssueCardChild}. Shares the same visible-only refresh timer and
 * teardown, but pulls from the search cache and renders a card list.
 */
class SearchBlockChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly plugin: GiteaCardsPlugin,
		private readonly query: SearchQuery
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.empty();
		this.containerEl.createDiv({
			cls: "gitea-card gitea-card--loading",
			text: "Loading issues…",
		});
		void this.refresh();

		this.registerInterval(
			window.setInterval(() => {
				if (!isElementVisible(this.containerEl)) {
					return;
				}
				void this.refresh();
			}, this.plugin.refreshIntervalMs)
		);
	}

	/** Pull from the shared search cache and rebuild the card list. */
	private async refresh(): Promise<void> {
		const result = await this.plugin.searchCache.load(
			this.query,
			this.plugin.refreshIntervalMs
		);
		if (!this.containerEl.isConnected) {
			return;
		}
		this.plugin.renderSearchResult(this.containerEl, this.query, result, () =>
			void this.refreshNow()
		);
	}

	/**
	 * Force a fresh fetch on demand (issue #36) — drop the shared cache entry so
	 * the next load bypasses the coalescing window (and any failure backoff), then
	 * rebuild. The toolbar's "Refresh" button drives this.
	 */
	private async refreshNow(): Promise<void> {
		this.plugin.searchCache.invalidate(this.query);
		await this.refresh();
	}
}

/**
 * Lifecycle wrapper for one `gitea-milestone` block — the progress-bar
 * counterpart to {@link IssueCardChild}. Shares the same visible-only refresh
 * timer and teardown, but pulls from the milestone cache.
 */
class MilestoneBlockChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly plugin: GiteaCardsPlugin,
		private readonly query: MilestoneQuery
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.empty();
		this.containerEl.createDiv({
			cls: "gitea-card gitea-card--loading",
			text: "Loading milestone…",
		});
		void this.refresh();

		this.registerInterval(
			window.setInterval(() => {
				if (!isElementVisible(this.containerEl)) {
					return;
				}
				void this.refresh();
			}, this.plugin.refreshIntervalMs)
		);
	}

	/** Pull from the shared milestone cache and rebuild the progress block. */
	private async refresh(): Promise<void> {
		const result = await this.plugin.milestoneCache.load(
			this.query,
			this.plugin.refreshIntervalMs
		);
		if (!this.containerEl.isConnected) {
			return;
		}
		this.plugin.renderMilestoneResult(this.containerEl, this.query, result);
	}
}

/**
 * Lifecycle wrapper for one `gitea-graph` block — the dependency-DAG counterpart
 * to {@link MilestoneBlockChild}. Shares the same visible-only refresh timer and
 * teardown, but pulls from the graph cache (which fans out to the issue list plus
 * a per-issue dependency call) and renders an SVG (issue #39).
 */
class GraphBlockChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly plugin: GiteaCardsPlugin,
		private readonly query: GraphQuery
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.empty();
		this.containerEl.createDiv({
			cls: "gitea-card gitea-card--loading",
			text: "Loading graph…",
		});
		void this.refresh();

		this.registerInterval(
			window.setInterval(() => {
				if (!isElementVisible(this.containerEl)) {
					return;
				}
				void this.refresh();
			}, this.plugin.refreshIntervalMs)
		);
	}

	/** Pull from the shared graph cache and rebuild the DAG. */
	private async refresh(): Promise<void> {
		const result = await this.plugin.graphCache.load(
			this.query,
			this.plugin.refreshIntervalMs
		);
		if (!this.containerEl.isConnected) {
			return;
		}
		this.plugin.renderGraphResult(this.containerEl, this.query, result, () =>
			void this.refreshNow()
		);
	}

	/**
	 * Force a fresh fetch on demand (issue #42) — drop the shared cache entry so
	 * the next load bypasses the coalescing window (and any failure backoff), then
	 * rebuild. The header's "Refresh" button drives this.
	 */
	private async refreshNow(): Promise<void> {
		this.plugin.graphCache.invalidate(this.query);
		await this.refresh();
	}
}

/**
 * Lifecycle wrapper for one inline chip. Tied to the chip element via
 * `ctx.addChild`, so its fetch is abandoned once the chip leaves the DOM. Pulls
 * the issue from the same shared cache the full cards use (one coalesced request
 * per issue per interval) to fill the hover-preview title and the state dot.
 * Like the cards, it re-pulls on the configured refresh interval so a chip's
 * state dot and title stay current without reopening the note (issue #27).
 */
class InlineChipChild extends MarkdownRenderChild {
	constructor(
		chipEl: HTMLElement,
		private readonly plugin: GiteaCardsPlugin,
		private readonly ref: IssueRef
	) {
		super(chipEl);
	}

	onload(): void {
		void this.loadIssue();

		// Auto-cancelled on unload (note closed/scrolled away or plugin unload).
		// Only visible chips hit the network; off-screen leaves are skipped.
		this.registerInterval(
			window.setInterval(() => {
				if (!isElementVisible(this.containerEl)) {
					return;
				}
				void this.loadIssue();
			}, this.plugin.refreshIntervalMs)
		);
	}

	private async loadIssue(): Promise<void> {
		const result = await this.plugin.cache.load(
			this.ref,
			this.plugin.refreshIntervalMs
		);
		// The chip may have been removed while the request was in flight.
		if (!this.containerEl.isConnected) {
			return;
		}
		const issue = result.value;
		if (!issue) {
			return;
		}
		applyChipState(
			this.containerEl,
			issue,
			this.plugin.settings.inProgressLabel
		);
	}
}

/**
 * Maps each Live Preview chip element to the issue it shows, so the editor
 * extension's refresh timer can re-pull and re-apply state to the chips that
 * are currently mounted (issue #27). A `WeakMap` lets entries fall away with
 * their detached chip elements — no manual cleanup on widget teardown.
 */
const liveChipRefs = new WeakMap<HTMLElement, IssueRef>();

/**
 * Live Preview counterpart of {@link InlineChipChild}: a CodeMirror widget that
 * renders the chip in the *editing* view, which the Markdown post-processor
 * never touches. Loads the issue from the shared cache, so it shares the same
 * coalescing/freshness as every other chip and card.
 */
class InlineChipWidget extends WidgetType {
	constructor(
		private readonly plugin: GiteaCardsPlugin,
		private readonly ref: IssueRef
	) {
		super();
	}

	eq(other: InlineChipWidget): boolean {
		return (
			other.ref.owner === this.ref.owner &&
			other.ref.repo === this.ref.repo &&
			other.ref.index === this.ref.index
		);
	}

	toDOM(): HTMLElement {
		const chip = createChipElement(
			this.plugin.settings.baseUrl,
			this.ref,
			this.plugin.settings.repoAccents[
				`${this.ref.owner}/${this.ref.repo}`
			]
		);
		// Record the ref so the editor extension's refresh timer can find this
		// chip's issue when it later re-pulls (issue #27).
		liveChipRefs.set(chip, this.ref);
		void this.plugin.cache
			.load(this.ref, this.plugin.refreshIntervalMs)
			.then((result) => {
				if (chip.isConnected && result.value) {
					applyChipState(
						chip,
						result.value,
						this.plugin.settings.inProgressLabel
					);
				}
			});
		return chip;
	}

	/** Let the anchor handle its own clicks rather than the editor. */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * Editor extension that mirrors the reading-view inline chips in Live Preview.
 * Replaces each backtick-wrapped `` `GITEA:owner/repo:#123` `` (an inline-code
 * span) with an {@link InlineChipWidget}, leaving bare references in prose alone
 * (issue #14). Skipped in source mode, and where the cursor/selection overlaps
 * the reference — there the raw text stays visible so it can be edited.
 */
function inlineChipEditorExtension(
	plugin: GiteaCardsPlugin
): ViewPlugin<{ decorations: DecorationSet }> {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			/** Periodic refresh timer, mirroring the cards (issue #27). */
			private readonly refreshTimer: number;

			constructor(private readonly view: EditorView) {
				this.decorations = this.build(view);
				// Re-pull each mounted chip's issue on the configured interval so a
				// chip's state dot and title stay current while editing, just like
				// the reading-view chip and the cards. CodeMirror only mounts chips
				// inside the visible viewport, so off-screen chips skip the network.
				this.refreshTimer = window.setInterval(() => {
					this.refreshChips();
				}, plugin.refreshIntervalMs);
			}

			update(update: ViewUpdate): void {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.selectionSet
				) {
					this.decorations = this.build(update.view);
				}
			}

			destroy(): void {
				window.clearInterval(this.refreshTimer);
			}

			/** Re-pull and re-apply state to every chip currently in the editor. */
			private refreshChips(): void {
				const chips =
					this.view.dom.querySelectorAll<HTMLElement>(".gitea-chip");
				chips.forEach((chip) => {
					const ref = liveChipRefs.get(chip);
					if (!ref) {
						return;
					}
					void plugin.cache
						.load(ref, plugin.refreshIntervalMs)
						.then((result) => {
							if (chip.isConnected && result.value) {
								applyChipState(
									chip,
									result.value,
									plugin.settings.inProgressLabel
								);
							}
						});
				});
			}

			private build(view: EditorView): DecorationSet {
				const builder = new RangeSetBuilder<Decoration>();
				// Source mode (and an empty keyword) leave the raw text untouched.
				if (
					!view.state.field(editorLivePreviewField) ||
					!plugin.settings.keyword
				) {
					return builder.finish();
				}
				const tree = syntaxTree(view.state);
				const selection = view.state.selection;
				for (const { from, to } of view.visibleRanges) {
					const text = view.state.doc.sliceString(from, to);
					const pattern = inlineChipSourcePattern(plugin.settings.keyword);
					for (
						let match = pattern.exec(text);
						match !== null;
						match = pattern.exec(text)
					) {
						// `start` is the opening backtick; `end` is just past the
						// closing one, so the widget replaces the whole inline-code
						// span (backticks included).
						const start = from + match.index;
						const end = start + match[0].length;
						// Keep the source visible while it is being edited.
						const overlapsCursor = selection.ranges.some(
							(range) => range.from <= end && range.to >= start
						);
						if (overlapsCursor) {
							continue;
						}
						// Only decorate a genuine inline-code span — a backtick pair
						// inside a fenced code block (node `CodeText`/`hmd-codeblock`)
						// or elsewhere must stay literal. Resolve just inside the
						// opening backtick, where the reference text sits.
						const nodeName = tree.resolveInner(start + 1, 1).type.name;
						if (!/inline.?code/i.test(nodeName)) {
							continue;
						}
						const ref: IssueRef = {
							owner: match[1],
							repo: match[2],
							index: Number.parseInt(match[3], 10),
						};
						builder.add(
							start,
							end,
							Decoration.replace({
								widget: new InlineChipWidget(plugin, ref),
							})
						);
					}
				}
				return builder.finish();
			}
		},
		{ decorations: (value) => value.decorations }
	);
}

/**
 * Inline single-issue autocomplete (F6). A multi-stage {@link EditorSuggest}:
 * typing the editable keyword + `:` suggests repos, and after `owner/repo:` it
 * suggests that repo's issues. `onTrigger` runs on every keystroke, so it bails
 * cheaply (a substring check, no lookbehind regex) on anything non-matching.
 */
class GiteaInlineSuggest extends EditorSuggest<InlineSuggestion> {
	/** Which stage the latest trigger landed in — set by `onTrigger`. */
	private stage: "repo" | "issue" = "repo";
	/** The `owner/repo` resolved for an issue-stage trigger. */
	private repoSlug = "";
	/**
	 * Column of the keyword's first character on the trigger line, recorded on an
	 * issue-stage trigger so {@link selectSuggestion} can wrap the *whole*
	 * reference (`GITEA:owner/repo:#123`) in backticks on completion — the chip
	 * only renders from a backtick-wrapped reference (issue #14).
	 */
	private referenceStart = 0;

	constructor(private readonly plugin: GiteaCardsPlugin) {
		super(plugin.app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_file: TFile | null
	): EditorSuggestTriggerInfo | null {
		const keyword = this.plugin.settings.keyword;
		if (!keyword) {
			return null;
		}
		const beforeCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
		// Cheap mandatory early-out: the vast majority of keystrokes never type
		// the keyword, so skip the regex entirely unless the marker is present.
		if (!beforeCursor.includes(`${keyword}:`)) {
			return null;
		}
		// `[^\s:]*` keeps a segment to a single token; the optional second group
		// distinguishes the repo stage (no second colon) from the issue stage.
		const pattern = new RegExp(
			`${escapeRegExp(keyword)}:([^\\s:]*)(?::([^\\s:]*))?$`
		);
		const match = pattern.exec(beforeCursor);
		if (!match) {
			return null;
		}
		const repoSegment = match[1];
		const issueSegment = match[2];

		if (issueSegment === undefined) {
			// Stage 1 — `GITEA:` plus a partial repo slug.
			this.stage = "repo";
			this.repoSlug = "";
			return {
				start: { line: cursor.line, ch: cursor.ch - repoSegment.length },
				end: cursor,
				query: repoSegment,
			};
		}

		// Stage 2 — `GITEA:owner/repo:` plus a partial issue. Needs a valid slug.
		const parsed = splitRepo(repoSegment);
		if (!parsed) {
			return null;
		}
		this.stage = "issue";
		this.repoSlug = `${parsed.owner}/${parsed.repo}`;
		// `match.index` is the keyword's column on the line (the pattern is anchored
		// at the cursor, not the start) — where the backtick wrapping begins.
		this.referenceStart = match.index;
		return {
			start: { line: cursor.line, ch: cursor.ch - issueSegment.length },
			end: cursor,
			query: issueSegment,
		};
	}

	async getSuggestions(
		context: EditorSuggestContext
	): Promise<InlineSuggestion[]> {
		const query = context.query.toLowerCase();
		try {
			if (this.stage === "repo") {
				const repos = await this.plugin.loadRepoList();
				return repos
					.filter((repo) => repo.toLowerCase().includes(query))
					.slice(0, 20)
					.map((repo) => ({ kind: "repo", repo }));
			}
			const needle = query.replace(/^#/, "");
			const issues = await this.plugin.loadInlineIssues(this.repoSlug);
			return issues
				.filter(
					(issue) =>
						String(issue.index).includes(needle) ||
						issue.title.toLowerCase().includes(needle)
				)
				.slice(0, 20)
				.map((issue) => ({
					kind: "issue",
					index: issue.index,
					title: issue.title,
					state: issue.state,
				}));
		} catch {
			return []; // A failed lookup just closes the popup.
		}
	}

	renderSuggestion(value: InlineSuggestion, el: HTMLElement): void {
		el.addClass("gitea-suggestion");
		if (value.kind === "repo") {
			el.createSpan({ cls: "gitea-suggestion__repo", text: value.repo });
			return;
		}
		el.createSpan({
			cls: "gitea-suggestion__number",
			text: `#${value.index}`,
		});
		el.createSpan({
			cls: "gitea-suggestion__title",
			text: `— ${value.title}`,
		});
	}

	selectSuggestion(value: InlineSuggestion): void {
		const ctx = this.context;
		if (!ctx) {
			return;
		}
		if (value.kind === "repo") {
			// Picking a repo leaves a trailing colon so the next keystroke-free
			// re-trigger advances to the issue stage.
			const insert = `${value.repo}:`;
			ctx.editor.replaceRange(insert, ctx.start, ctx.end);
			ctx.editor.setCursor({
				line: ctx.start.line,
				ch: ctx.start.ch + insert.length,
			});
			return;
		}
		// Picking an issue completes the reference and wraps the whole thing in
		// backticks, since the chip only renders from a backtick-wrapped
		// (inline-code) reference — a bare reference in prose is left alone (issue
		// #14). Absorb any backticks the user already typed around the reference so
		// we never end up doubling them.
		const line = ctx.editor.getLine(ctx.start.line);
		let startCh = this.referenceStart;
		if (startCh > 0 && line.charAt(startCh - 1) === "`") {
			startCh -= 1;
		}
		let endCh = ctx.end.ch;
		if (line.charAt(endCh) === "`") {
			endCh += 1;
		}
		const insert = `\`${this.plugin.settings.keyword}:${this.repoSlug}:#${value.index}\``;
		ctx.editor.replaceRange(
			insert,
			{ line: ctx.start.line, ch: startCh },
			{ line: ctx.end.line, ch: endCh }
		);
		ctx.editor.setCursor({
			line: ctx.start.line,
			ch: startCh + insert.length,
		});
	}
}

/**
 * The insert-existing-issue form. Pick a repo and one of its issues, then drop
 * the matching `gitea-issue` card into the editor at the cursor. Reuses the same
 * repo/issue lookups as the inline `GITEA:` autocomplete and the same card-block
 * builder as the new-issue flow, so it stays a thin UI over existing wiring.
 */
/**
 * Full-size, in-app lightbox for a comment image (issue #53, maintainer Q4 — an
 * in-app modal, not the system browser). Loads the same token-authed bytes as the
 * thumbnail through {@link GiteaCardsPlugin.loadAuthedImage}, owned by a private
 * {@link Component} so the object URL is revoked when the modal closes (a `Modal`
 * is not itself a `Component`, so it can't own the revocation directly).
 */
class ImageLightboxModal extends Modal {
	private readonly owner = new Component();

	constructor(
		private readonly plugin: GiteaCardsPlugin,
		private readonly url: string,
		private readonly alt: string
	) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		this.owner.load();
		const { contentEl, modalEl } = this;
		modalEl.addClass("gitea-lightbox-modal");
		contentEl.empty();
		contentEl.addClass("gitea-lightbox");
		const status = contentEl.createDiv({
			cls: "gitea-lightbox__status",
			text: "Loading image…",
		});
		try {
			const objectUrl = await this.plugin.loadAuthedImage(
				this.url,
				this.owner
			);
			if (!contentEl.isConnected) {
				return;
			}
			status.remove();
			const img = contentEl.createEl("img", {
				cls: "gitea-lightbox__image",
			});
			img.setAttr("src", objectUrl);
			if (this.alt) {
				img.setAttr("alt", this.alt);
			}
		} catch (error: unknown) {
			if (!contentEl.isConnected) {
				return;
			}
			status.setText(
				error instanceof Error
					? error.message
					: "Image could not be loaded."
			);
		}
	}

	onClose(): void {
		// Revokes the object URL minted above (registered on the owner component).
		this.owner.unload();
		this.contentEl.empty();
	}
}

class InsertIssueModal extends Modal {
	private repo: string;
	private issues: InlineIssueSummary[] = [];
	private selectedIndex: number | null = null;
	private insertFormat: IssueInsertFormat;

	private repoSetting: Setting | null = null;
	private issueEl: HTMLElement | null = null;
	private insertButton: ButtonComponent | null = null;

	constructor(
		private readonly plugin: GiteaCardsPlugin,
		private readonly editor: Editor
	) {
		super(plugin.app);
		this.repo = plugin.settings.defaultRepo;
		// "None" is only meaningful when creating an issue (issue #37); inserting an
		// *existing* issue as nothing is pointless, so fall back to a card here.
		this.insertFormat =
			plugin.settings.insertFormat === "none"
				? "card"
				: plugin.settings.insertFormat;
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("Insert existing issue");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gitea-insert-issue");

		// Repo picker — populated asynchronously below.
		this.repoSetting = new Setting(contentEl).setName("Repository");

		// Issue picker — rebuilt whenever the repo changes.
		this.issueEl = contentEl.createDiv();

		// Card vs. compact inline status, mirroring the new-issue modal (issue #21).
		new Setting(contentEl)
			.setName("Insert as")
			.setDesc("Drop a full card or a compact inline status into the note.")
			.addDropdown((dropdown) => {
				dropdown.addOption("card", "Card");
				dropdown.addOption("inline", "Inline status");
				dropdown.setValue(this.insertFormat);
				dropdown.onChange((value) => {
					this.insertFormat = value as IssueInsertFormat;
					// Remember the choice so it sticks for the next insert.
					this.plugin.settings.insertFormat = this.insertFormat;
					void this.plugin.saveSettings();
				});
			});

		new Setting(contentEl).addButton((button) => {
			this.insertButton = button;
			button
				.setButtonText("Insert")
				.setCta()
				.onClick(() => this.submit());
		});

		await this.renderRepoControl();
		await this.renderIssues();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * Fill the repo picker. Offers a dropdown of repos the token can see (with the
	 * default always selectable); if the list can't be fetched, falls back to a
	 * free-text field plus a reload button so the issue list can still be pulled.
	 * Mirrors {@link NewIssueModal}'s repo control.
	 */
	private async renderRepoControl(): Promise<void> {
		const setting = this.repoSetting;
		if (!setting) {
			return;
		}
		try {
			const repos = await this.plugin.fetchRepos();
			const options = [
				...new Set([this.repo, ...repos].filter((slug) => slug.length > 0)),
			];
			if (!this.repo && options.length > 0) {
				this.repo = options[0];
			}
			setting.setDesc("Repository to insert an issue from.");
			setting.addDropdown((dropdown) => {
				for (const slug of options) {
					dropdown.addOption(slug, slug);
				}
				dropdown.setValue(this.repo);
				dropdown.onChange((value) => {
					this.repo = value;
					void this.renderIssues();
				});
			});
		} catch {
			setting.setDesc("Repository in owner/repo form.");
			setting.addText((text) => {
				text.setValue(this.repo).onChange((value) => {
					this.repo = value.trim();
				});
			});
			setting.addExtraButton((button) => {
				button
					.setIcon("refresh-cw")
					.setTooltip("Load issues")
					.onClick(() => void this.renderIssues());
			});
		}
	}

	/**
	 * Rebuild the issue dropdown for the current repo. Fetches the repo's issues
	 * (PRs already excluded by {@link GiteaCardsPlugin.fetchInlineIssues}), guards
	 * against a repo change that lands while the request is in flight, and shows a
	 * one-line notice for an empty list or a failed lookup.
	 */
	private async renderIssues(): Promise<void> {
		const container = this.issueEl;
		if (!container) {
			return;
		}
		this.selectedIndex = null;
		this.issues = [];
		container.empty();

		const parsed = splitRepo(this.repo);
		if (!parsed) {
			container.createDiv({
				cls: "gitea-insert-issue__notice",
				text: "Enter a repository in owner/repo form.",
			});
			return;
		}

		const repoAtFetch = this.repo;
		container.createDiv({
			cls: "gitea-insert-issue__notice",
			text: "Loading issues…",
		});
		let issues: InlineIssueSummary[];
		try {
			issues = await this.plugin.fetchInlineIssues(this.repo);
		} catch (error) {
			if (this.repo !== repoAtFetch) {
				return; // A newer render superseded this one.
			}
			container.empty();
			container.createDiv({
				cls: "gitea-insert-issue__notice",
				text:
					error instanceof Error
						? error.message
						: "Could not load issues.",
			});
			return;
		}
		if (this.repo !== repoAtFetch) {
			return; // A newer render superseded this one.
		}

		this.issues = issues;
		container.empty();

		if (issues.length === 0) {
			container.createDiv({
				cls: "gitea-insert-issue__notice",
				text: "This repository has no issues.",
			});
			return;
		}

		this.selectedIndex = issues[0].index;
		new Setting(container).setName("Issue").addDropdown((dropdown) => {
			for (const issue of issues) {
				const closed = issue.state === "closed" ? " (closed)" : "";
				dropdown.addOption(
					String(issue.index),
					`#${issue.index} — ${issue.title}${closed}`
				);
			}
			dropdown.setValue(String(this.selectedIndex));
			dropdown.onChange((value) => {
				this.selectedIndex = Number.parseInt(value, 10);
			});
		});
	}

	/**
	 * Insert the picked issue in the chosen format — a `gitea-issue` card or a
	 * compact inline status chip — at the cursor (or over any selection), then
	 * close. Validates the repo and that an issue is selected first.
	 */
	private submit(): void {
		const parsed = splitRepo(this.repo);
		if (!parsed) {
			new Notice("Enter a repository in owner/repo form.");
			return;
		}
		if (this.selectedIndex === null) {
			new Notice("Choose an issue to insert.");
			return;
		}
		const ref: IssueRef = {
			owner: parsed.owner,
			repo: parsed.repo,
			index: this.selectedIndex,
		};
		insertIssueReference(
			this.editor,
			ref,
			this.insertFormat,
			this.plugin.settings.keyword
		);
		this.close();
	}
}

/** Options seeding a {@link NewIssueModal}. */
interface NewIssueModalOptions {
	/**
	 * Editor to drop the resulting card into on success, when invoked from one.
	 * `replaceSelection` inserts at the cursor with no selection (the new-issue
	 * command) and replaces the selection when one is present (convert-selection).
	 */
	editor: Editor | null;
	/** Initial body text — the selection, for the convert-selection command. */
	body?: string;
	/**
	 * Repo (`owner/repo`) to preselect, overriding the remembered/default repo.
	 * Set by the search block's "Add issue" button so a new issue starts in the
	 * repo the table is scoped to (issue #35).
	 */
	repo?: string;
	/**
	 * Label *names* to preselect once the repo's labels load — the labels the
	 * originating search filtered on, so the new issue matches the table it was
	 * created from (issue #35). Names not present in the repo are ignored.
	 */
	labels?: string[];
	/**
	 * Milestone *name* to preselect once the repo's milestones load — the
	 * milestone the originating search filtered on (issue #35). Ignored if the
	 * repo has no open milestone by that name.
	 */
	milestone?: string;
	/**
	 * Insert format to preselect, overriding the remembered choice. The search
	 * block's "Add issue" button passes `none` so a new issue is created without
	 * dropping a card into the note — the issue already shows up in the table it
	 * was added from (issue #37).
	 */
	defaultInsertFormat?: IssueInsertFormat;
}

/**
 * The new-issue / convert-selection form. Collects a repo, title, body, labels,
 * milestone, and assignees, maps the picked label/milestone names to the IDs the
 * create endpoint requires, POSTs the issue, and — when invoked from an editor —
 * drops the resulting `gitea-issue` card in at the cursor (or over the selection).
 */
class NewIssueModal extends Modal {
	private repo: string;
	private title = "";
	private body: string;
	private selectedLabelIds = new Set<number>();
	private milestoneId: number | null = null;
	private assignees = "";
	private insertFormat: IssueInsertFormat;

	private labels: GiteaLabel[] = [];
	private milestones: GiteaMilestoneListItem[] = [];

	private repoSetting: Setting | null = null;
	private metaEl: HTMLElement | null = null;
	private attachEl: HTMLElement | null = null;
	private submitButton: ButtonComponent | null = null;
	private submitting = false;

	/** Images queued in the picker, uploaded after the issue is created (issue #57). */
	private pendingFiles: File[] = [];
	/** Object URLs backing the thumbnail previews; revoked on rebuild/close. */
	private previewUrls: string[] = [];
	/**
	 * The live thumbnail-preview grid, kept so a screenshot pasted into the
	 * description can refresh it (issue #58). Null whenever the image picker is
	 * absent (setting off or the token can't write the repo).
	 */
	private previewsEl: HTMLElement | null = null;
	/**
	 * Whether the image picker is currently active — the default-off image setting
	 * is on *and* the token can write the repo. Gates the body paste-to-attach
	 * (issue #58); recomputed on every repo switch by {@link renderAttachSection}.
	 */
	private attachEnabled = false;

	constructor(
		private readonly plugin: GiteaCardsPlugin,
		private readonly options: NewIssueModalOptions
	) {
		super(plugin.app);
		// A repo passed in (e.g. the search block's "Add issue" button, issue #35)
		// wins; otherwise prefer the repo of the last issue created here, falling
		// back to the configured default before any have been made (issue #23).
		this.repo =
			options.repo || plugin.settings.lastRepo || plugin.settings.defaultRepo;
		this.body = options.body ?? "";
		// A caller-supplied default (the search block's "Add issue" button passes
		// "none", issue #37) wins over the remembered choice.
		this.insertFormat =
			options.defaultInsertFormat ?? plugin.settings.insertFormat;
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("New issue");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gitea-new-issue");

		// Repo picker — populated asynchronously below.
		this.repoSetting = new Setting(contentEl).setName("Repository");

		new Setting(contentEl).setName("Title").addText((text) => {
			text.setPlaceholder("Issue title").onChange((value) => {
				this.title = value;
			});
		});

		new Setting(contentEl).setName("Description").addTextArea((area) => {
			area.setValue(this.body).onChange((value) => {
				this.body = value;
			});
			area.inputEl.rows = 6;
			area.inputEl.addClass("gitea-new-issue__body");
			// Pasting a screenshot into the description queues it in the image
			// picker (issue #58), mirroring the comment box's paste-to-attach (I5).
			// Non-image pastes — and pastes when the picker is unavailable — fall
			// through as ordinary text.
			area.inputEl.addEventListener("paste", (evt) => {
				this.handleBodyPaste(evt);
			});
		});

		// Labels / milestone / assignees depend on the repo; (re)built here.
		this.metaEl = contentEl.createDiv();

		// Image picker (issue #57). Gated on the same default-off image setting as
		// the comment attach (I5) and hidden when the token can't write the repo;
		// rebuilt per repo because write scope is repo-specific.
		this.attachEl = contentEl.createDiv();

		// Let the author choose how the new issue lands in the note: a full card
		// or a compact inline status chip (issue #21). Only meaningful when invoked
		// from an editor — without one there is nothing to insert into.
		if (this.options.editor) {
			new Setting(contentEl)
				.setName("Insert as")
				.setDesc(
					"Drop a full card, a compact inline status, or nothing into the note."
				)
				.addDropdown((dropdown) => {
					dropdown.addOption("card", "Card");
					dropdown.addOption("inline", "Inline status");
					dropdown.addOption("none", "None");
					dropdown.setValue(this.insertFormat);
					dropdown.onChange((value) => {
						this.insertFormat = value as IssueInsertFormat;
						// Remember the choice so it sticks for the next issue.
						this.plugin.settings.insertFormat = this.insertFormat;
						void this.plugin.saveSettings();
					});
				});
		}

		new Setting(contentEl).addButton((button) => {
			this.submitButton = button;
			button
				.setButtonText("Create issue")
				.setCta()
				.onClick(() => void this.submit());
		});

		// Submit with Ctrl/Cmd+Enter so the form is fully keyboard-driven (issue
		// #25). The modal's scope is pushed on open and popped on close, so this
		// needs no explicit teardown.
		this.scope.register(["Mod"], "Enter", (event) => {
			event.preventDefault();
			void this.submit();
			return false;
		});

		await this.renderRepoControl();
		await this.renderMetadata();
		await this.renderAttachSection();
	}

	onClose(): void {
		this.clearPreviewUrls();
		this.contentEl.empty();
	}

	/**
	 * Fill the repo picker. Offers a dropdown of repos the token can see (with the
	 * default always selectable); if the list can't be fetched, falls back to a
	 * free-text field plus a reload button so metadata can still be pulled.
	 */
	private async renderRepoControl(): Promise<void> {
		const setting = this.repoSetting;
		if (!setting) {
			return;
		}
		try {
			const repos = await this.plugin.fetchRepos();
			const options = [
				...new Set([this.repo, ...repos].filter((slug) => slug.length > 0)),
			];
			if (!this.repo && options.length > 0) {
				this.repo = options[0];
			}
			setting.setDesc("Repository to create the issue in.");
			setting.addDropdown((dropdown) => {
				for (const slug of options) {
					dropdown.addOption(slug, slug);
				}
				dropdown.setValue(this.repo);
				dropdown.onChange((value) => {
					this.repo = value;
					void this.renderMetadata();
					void this.renderAttachSection();
				});
			});
		} catch {
			setting.setDesc("Repository in owner/repo form.");
			setting.addText((text) => {
				text.setValue(this.repo).onChange((value) => {
					this.repo = value.trim();
				});
			});
			setting.addExtraButton((button) => {
				button
					.setIcon("refresh-cw")
					.setTooltip("Load labels and milestones")
					.onClick(() => {
						void this.renderMetadata();
						void this.renderAttachSection();
					});
			});
		}
	}

	/**
	 * Rebuild the label/milestone/assignee section for the current repo. Fetches
	 * the repo's labels and open milestones, guarding against a repo change that
	 * lands while the request is in flight.
	 */
	private async renderMetadata(): Promise<void> {
		const container = this.metaEl;
		if (!container) {
			return;
		}
		this.selectedLabelIds.clear();
		this.milestoneId = null;
		container.empty();

		const parsed = splitRepo(this.repo);
		if (!parsed) {
			container.createDiv({
				cls: "gitea-new-issue__notice",
				text: "Enter a repository in owner/repo form.",
			});
			return;
		}

		const repoAtFetch = this.repo;
		container.createDiv({
			cls: "gitea-new-issue__notice",
			text: "Loading labels and milestones…",
		});
		let labels: GiteaLabel[];
		let milestones: GiteaMilestoneListItem[];
		try {
			[labels, milestones] = await Promise.all([
				this.plugin.fetchLabels(this.repo),
				this.plugin.fetchMilestones(this.repo),
			]);
		} catch (error) {
			if (this.repo !== repoAtFetch) {
				return; // A newer render superseded this one.
			}
			container.empty();
			container.createDiv({
				cls: "gitea-new-issue__notice",
				text:
					error instanceof Error
						? error.message
						: "Could not load repository metadata.",
			});
			return;
		}
		if (this.repo !== repoAtFetch) {
			return; // A newer render superseded this one.
		}

		this.labels = labels;
		this.milestones = milestones.filter((m) => m.state !== "closed");

		// Seed the labels/milestone the originating search filtered on, but only
		// while showing the repo that prefill came from — a manual repo switch
		// should start clean, since labels/milestones are repo-scoped (issue #35).
		if (this.options.repo && this.repo === this.options.repo) {
			this.applyPrefill();
		}

		container.empty();
		this.renderLabelOptions(container);
		this.renderMilestoneOption(container);
		this.renderAssigneesOption(container);
	}

	/**
	 * Pre-select the labels and milestone carried over from the originating search
	 * (issue #35), matching by name (case-insensitive on the trimmed value) against
	 * the freshly fetched repo metadata. Names with no match in the repo are
	 * silently dropped. Called from {@link renderMetadata} before the controls are
	 * built, so the chips/dropdown render already reflecting the selection.
	 */
	private applyPrefill(): void {
		const wantedLabels = new Set(
			(this.options.labels ?? [])
				.map((name) => name.trim().toLowerCase())
				.filter((name) => name.length > 0)
		);
		if (wantedLabels.size > 0) {
			for (const label of this.labels) {
				if (wantedLabels.has(label.name.trim().toLowerCase())) {
					this.selectedLabelIds.add(label.id);
				}
			}
		}
		const wantedMilestone = this.options.milestone?.trim().toLowerCase();
		if (wantedMilestone) {
			const match = this.milestones.find(
				(milestone) => milestone.title.trim().toLowerCase() === wantedMilestone
			);
			if (match) {
				this.milestoneId = match.id;
			}
		}
	}

	/**
	 * Render the repo's labels as a wrapping grid of toggleable colour chips.
	 * Tapping a chip flips its membership in {@link selectedLabelIds}; the grid is
	 * height-capped and scrolls, so a repo with many labels can never grow the
	 * modal unbounded (the original per-row toggles did). Multi-select needs no
	 * commas or typeahead — just tap each label you want.
	 */
	private renderLabelOptions(container: HTMLElement): void {
		new Setting(container).setName("Labels").setHeading();
		if (this.labels.length === 0) {
			container.createDiv({
				cls: "gitea-new-issue__notice",
				text: "This repository has no labels.",
			});
			return;
		}
		const grid = container.createDiv({ cls: "gitea-new-issue__labels" });
		for (const label of this.labels) {
			const chip = grid.createEl("button", {
				cls: "gitea-new-issue__label",
				text: label.name,
			});
			chip.type = "button";
			// Dynamic per-label colour from the API; the static rules live in
			// styles.css, mirroring the read-only card label chips.
			chip.style.setProperty("--gitea-label-bg", `#${label.color}`);
			chip.style.setProperty(
				"--gitea-label-fg",
				labelTextColor(label.color)
			);
			const sync = () => {
				const selected = this.selectedLabelIds.has(label.id);
				chip.toggleClass("is-selected", selected);
				chip.setAttr("aria-pressed", selected ? "true" : "false");
			};
			sync();
			chip.addEventListener("click", () => {
				if (this.selectedLabelIds.has(label.id)) {
					this.selectedLabelIds.delete(label.id);
				} else {
					this.selectedLabelIds.add(label.id);
				}
				sync();
			});
		}
	}

	private renderMilestoneOption(container: HTMLElement): void {
		new Setting(container).setName("Milestone").addDropdown((dropdown) => {
			dropdown.addOption("", "None");
			for (const milestone of this.milestones) {
				dropdown.addOption(String(milestone.id), milestone.title);
			}
			// Reflect a milestone carried over from the originating search (issue #35).
			dropdown.setValue(
				this.milestoneId !== null ? String(this.milestoneId) : ""
			);
			dropdown.onChange((value) => {
				this.milestoneId = value ? Number.parseInt(value, 10) : null;
			});
		});
	}

	private renderAssigneesOption(container: HTMLElement): void {
		new Setting(container)
			.setName("Assignees")
			.setDesc("Comma-separated usernames.")
			.addText((text) => {
				text.setValue(this.assignees).onChange((value) => {
					this.assignees = value;
				});
			});
	}

	/**
	 * (Re)build the image picker (issue #57). Hidden unless the default-off image
	 * setting is on *and* the token can write the current repo — the same gate the
	 * card's quick actions and the comment attach use. Rebuilt on every repo switch
	 * because write scope is repo-specific; a repo the token can't write drops the
	 * picker and clears any queued files so a doomed upload can't be attempted.
	 */
	private async renderAttachSection(): Promise<void> {
		const container = this.attachEl;
		if (!container) {
			return;
		}
		container.empty();
		this.clearPreviewUrls();
		// Default to "no picker" until proven otherwise, so a stale grid from a
		// previous repo can't catch a body paste (issue #58).
		this.previewsEl = null;
		this.attachEnabled = false;

		if (!this.plugin.settings.showCommentImages) {
			this.pendingFiles = [];
			return;
		}

		const repoAtFetch = this.repo;
		let canWrite = false;
		try {
			canWrite = await this.plugin.loadRepoCanWrite(this.repo);
		} catch {
			canWrite = false;
		}
		if (this.repo !== repoAtFetch) {
			return; // A newer render superseded this one.
		}
		if (!canWrite) {
			this.pendingFiles = [];
			return;
		}

		new Setting(container).setName("Images").setHeading();
		const fileInput = container.createEl("input", {
			cls: "gitea-new-issue__file",
		});
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.multiple = true;
		fileInput.setAttr("aria-label", "Attach images");

		const previews = container.createDiv({ cls: "gitea-new-issue__previews" });
		this.previewsEl = previews;
		this.attachEnabled = true;
		fileInput.addEventListener("change", () => {
			const picked = Array.from(fileInput.files ?? []).filter((file) =>
				file.type.startsWith("image/")
			);
			// Reset so re-picking the same file still fires `change`.
			fileInput.value = "";
			if (picked.length > 0) {
				this.pendingFiles.push(...picked);
				this.renderPreviews(previews);
			}
		});
		this.renderPreviews(previews);
	}

	/**
	 * Queue any images pasted into the description into the picker (issue #58),
	 * mirroring the comment box's paste-to-attach (I5). Only acts when the image
	 * picker is active (the default-off image setting is on and the token can write
	 * the repo); otherwise — and for non-image pastes — the event is left alone so
	 * the paste falls through as ordinary text. Queued files upload after the issue
	 * is created, exactly like ones chosen through the file picker, so a paste and a
	 * pick are indistinguishable downstream. A notice confirms the queue, since a
	 * pasted image lands as a thumbnail below rather than as text in the box.
	 */
	private handleBodyPaste(evt: ClipboardEvent): void {
		if (!this.attachEnabled || !this.previewsEl) {
			return;
		}
		const images = Array.from(evt.clipboardData?.items ?? [])
			.filter(
				(entry) => entry.kind === "file" && entry.type.startsWith("image/")
			)
			.map((entry) => entry.getAsFile())
			.filter((file): file is File => file !== null);
		if (images.length === 0) {
			return;
		}
		evt.preventDefault();
		this.pendingFiles.push(...images);
		this.renderPreviews(this.previewsEl);
		new Notice(
			images.length === 1
				? "Image queued."
				: `${images.length} images queued.`
		);
	}

	/**
	 * Render a removable thumbnail per queued file. Each preview is a blob object
	 * URL (revoked on the next rebuild / on close) — no bytes are uploaded until
	 * the issue is created. Rebuilt wholesale on add/remove so indices stay sound.
	 */
	private renderPreviews(grid: HTMLElement): void {
		grid.empty();
		this.clearPreviewUrls();
		this.pendingFiles.forEach((file, index) => {
			const item = grid.createDiv({ cls: "gitea-new-issue__preview" });
			const url = URL.createObjectURL(file);
			this.previewUrls.push(url);
			const img = item.createEl("img", {
				cls: "gitea-new-issue__preview-img",
			});
			img.src = url;
			img.alt = file.name;
			const remove = item.createEl("button", {
				cls: "gitea-new-issue__preview-remove",
				text: "×",
			});
			remove.type = "button";
			remove.setAttr("aria-label", `Remove ${file.name}`);
			remove.addEventListener("click", () => {
				this.pendingFiles.splice(index, 1);
				this.renderPreviews(grid);
			});
		});
	}

	/** Revoke every preview object URL, so they can't leak across rebuilds/close. */
	private clearPreviewUrls(): void {
		for (const url of this.previewUrls) {
			URL.revokeObjectURL(url);
		}
		this.previewUrls = [];
	}

	/**
	 * Validate, map the picked label/milestone names to IDs, POST the issue, and
	 * on success drop a `gitea-issue` card into the editor and close. Errors are
	 * surfaced as a notice with the submit button re-enabled for a retry.
	 */
	private async submit(): Promise<void> {
		if (this.submitting) {
			return;
		}
		const title = this.title.trim();
		if (!title) {
			new Notice("Enter a title for the issue.");
			return;
		}
		const parsed = splitRepo(this.repo);
		if (!parsed) {
			new Notice("Enter a repository in owner/repo form.");
			return;
		}

		this.submitting = true;
		this.submitButton?.setDisabled(true).setButtonText("Creating…");

		const payload: CreateIssuePayload = {
			title,
			body: this.body,
			labels: [...this.selectedLabelIds],
			assignees: splitList(this.assignees),
		};
		if (this.milestoneId !== null) {
			payload.milestone = this.milestoneId;
		}

		let issue: GiteaIssue;
		try {
			issue = await this.plugin.createIssue(this.repo, payload);
		} catch (error) {
			// Create failed — nothing exists yet, so re-enable for a clean retry.
			new Notice(
				error instanceof Error
					? error.message
					: "Could not create the issue."
			);
			this.submitting = false;
			this.submitButton?.setDisabled(false).setButtonText("Create issue");
			return;
		}

		const ref: IssueRef = {
			owner: parsed.owner,
			repo: parsed.repo,
			index: issue.number,
		};

		// Upload any queued images to the now-existing issue, then PATCH the body to
		// append their markdown so the card shows them (issue #57). The issue is
		// already created, so a partway failure must NOT re-enable submit (that would
		// duplicate the issue) — instead it's surfaced as a notice that names what
		// landed, and whatever uploaded successfully is still spliced into the body.
		if (this.pendingFiles.length > 0) {
			this.submitButton?.setButtonText("Uploading images…");
			await this.attachPendingImages(ref, issue.number);
		}

		if (this.options.editor) {
			insertIssueReference(
				this.options.editor,
				ref,
				this.insertFormat,
				this.plugin.settings.keyword
			);
		}
		// Remember this repo so the next New issue defaults to it (issue #23).
		if (this.plugin.settings.lastRepo !== this.repo) {
			this.plugin.settings.lastRepo = this.repo;
			void this.plugin.saveSettings();
		}
		new Notice(`Created issue #${issue.number}.`);
		this.close();
	}

	/**
	 * Upload the queued images to the created issue and append their markdown to the
	 * body (issue #57). Best-effort by design: the issue already exists, so this
	 * never throws — it uploads each file, stops at the first failure, PATCHes the
	 * body with whatever succeeded (so nothing is silently dropped), and surfaces a
	 * clear notice naming the issue if any image didn't make it.
	 */
	private async attachPendingImages(
		ref: IssueRef,
		index: number
	): Promise<void> {
		const uploaded: string[] = [];
		let failure: Error | null = null;
		for (const file of this.pendingFiles) {
			try {
				const name =
					file.name && file.name.trim()
						? file.name
						: defaultImageName(file.type);
				const bytes = await file.arrayBuffer();
				const attachment = await this.plugin.uploadIssueAsset(
					ref,
					name,
					file.type,
					bytes
				);
				uploaded.push(attachmentMarkdown(attachment));
			} catch (error) {
				failure =
					error instanceof Error
						? error
						: new Error("Image upload failed.");
				break;
			}
		}

		if (uploaded.length > 0) {
			const appended = uploaded.join("\n\n");
			const newBody =
				this.body.trim().length > 0
					? `${this.body.replace(/\s+$/, "")}\n\n${appended}`
					: appended;
			try {
				await this.plugin.editIssueBody(ref, newBody);
			} catch (error) {
				failure =
					error instanceof Error
						? error
						: new Error("Could not update the issue body.");
			}
		}

		if (failure) {
			new Notice(
				`Created issue #${index}, but not all images were attached: ${failure.message}`
			);
		}
	}
}

/**
 * A form-driven builder for `gitea-search` blocks (issue #34). Rather than
 * memorising the `key: value` field syntax, the author picks a repo, state,
 * labels, milestone, keyword, result limit, and layout; a live preview shows the
 * exact block, and "Insert" drops it at the cursor. Labels and milestones are
 * fetched from the chosen repo (toggleable colour chips / a dropdown), falling
 * back to free-text fields for a global, cross-repo search where there is no
 * single repo to enumerate. Reuses {@link buildSearchBlock} so the preview and
 * the inserted block can never drift.
 */
class SearchQueryWizardModal extends Modal {
	private repo: string;
	private state = "open";
	/** Selected label *names* in repo-scoped mode (chip toggles). */
	private selectedLabels = new Set<string>();
	/** Comma-separated label names in global mode (no repo to enumerate). */
	private labelsText = "";
	/** Selected milestone *name* in repo-scoped mode ("" = none). */
	private milestone = "";
	/** Comma-separated milestone names in global mode. */
	private milestonesText = "";
	private q = "";
	private limit = SEARCH_DEFAULT_LIMIT;
	private layout: SearchLayout = "table";

	private labels: GiteaLabel[] = [];
	private milestones: GiteaMilestoneListItem[] = [];

	private repoSetting: Setting | null = null;
	private metaEl: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;

	constructor(
		private readonly plugin: GiteaCardsPlugin,
		private readonly editor: Editor
	) {
		super(plugin.app);
		// Default to the repo of the last issue created here, falling back to the
		// configured default; an empty value means a global, cross-repo search.
		this.repo = plugin.settings.lastRepo || plugin.settings.defaultRepo;
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("Build search query");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gitea-search-wizard");

		// Repo picker — populated asynchronously below.
		this.repoSetting = new Setting(contentEl).setName("Repository");

		new Setting(contentEl)
			.setName("State")
			.setDesc("Which issues to include.")
			.addDropdown((dropdown) => {
				dropdown.addOption("open", "Open");
				dropdown.addOption("closed", "Closed");
				dropdown.addOption("all", "All");
				dropdown.setValue(this.state);
				dropdown.onChange((value) => {
					this.state = value;
					this.updatePreview();
				});
			});

		// Labels / milestone depend on the repo; (re)built here.
		this.metaEl = contentEl.createDiv();

		new Setting(contentEl)
			.setName("Keyword")
			.setDesc("Free-text match on issue title and body.")
			.addText((text) => {
				text.setPlaceholder("Optional").onChange((value) => {
					this.q = value;
					this.updatePreview();
				});
			});

		new Setting(contentEl)
			.setName("Limit")
			.setDesc(`How many results to render (max ${SEARCH_MAX_LIMIT}).`)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = String(SEARCH_MAX_LIMIT);
				text.setValue(String(this.limit)).onChange((value) => {
					const parsed = Number.parseInt(value, 10);
					this.limit =
						Number.isFinite(parsed) && parsed > 0
							? Math.min(parsed, SEARCH_MAX_LIMIT)
							: SEARCH_DEFAULT_LIMIT;
					this.updatePreview();
				});
			});

		new Setting(contentEl)
			.setName("Layout")
			.setDesc("Compact table of rows or a list of full cards.")
			.addDropdown((dropdown) => {
				dropdown.addOption("table", "Table");
				dropdown.addOption("cards", "Cards");
				dropdown.setValue(this.layout);
				dropdown.onChange((value) => {
					this.layout = value as SearchLayout;
					this.updatePreview();
				});
			});

		new Setting(contentEl).setName("Preview").setHeading();
		this.previewEl = contentEl.createEl("pre", {
			cls: "gitea-search-wizard__preview",
		});

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText("Insert")
				.setCta()
				.onClick(() => this.submit());
		});

		// Insert with Ctrl/Cmd+Enter so the form is fully keyboard-driven, matching
		// the new-issue modal. Scope is auto-popped on close.
		this.scope.register(["Mod"], "Enter", (event) => {
			event.preventDefault();
			this.submit();
			return false;
		});

		await this.renderRepoControl();
		await this.renderMetadata();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * The query described by the current control state. Label/milestone sources
	 * switch on whether the repo resolves to an `owner/repo`: chip/dropdown
	 * selections when scoped, comma-separated text in the global fallback.
	 */
	private currentQuery(): SearchQuery {
		const scoped = splitRepo(this.repo) !== null;
		return {
			repo: this.repo.trim() || null,
			state: this.state,
			labels: scoped ? [...this.selectedLabels] : splitList(this.labelsText),
			milestones: scoped
				? this.milestone
					? [this.milestone]
					: []
				: splitList(this.milestonesText),
			q: this.q.trim() || null,
			limit: this.limit,
			layout: this.layout,
		};
	}

	/** Re-render the live block preview from the current control state. */
	private updatePreview(): void {
		this.previewEl?.setText(buildSearchBlock(this.currentQuery()).trimEnd());
	}

	/**
	 * Fill the repo picker. Offers a dropdown of repos the token can see plus an
	 * "all repositories" option for a global search; if the list can't be fetched,
	 * falls back to a free-text field plus a reload button. Mirrors the new-issue
	 * and insert-issue modals' repo control.
	 */
	private async renderRepoControl(): Promise<void> {
		const setting = this.repoSetting;
		if (!setting) {
			return;
		}
		try {
			const repos = await this.plugin.fetchRepos();
			const options = [
				...new Set([this.repo, ...repos].filter((slug) => slug.length > 0)),
			];
			setting.setDesc("Repository to search, or all repositories.");
			setting.addDropdown((dropdown) => {
				dropdown.addOption("", "All repositories (global)");
				for (const slug of options) {
					dropdown.addOption(slug, slug);
				}
				dropdown.setValue(this.repo);
				dropdown.onChange((value) => {
					this.repo = value;
					void this.renderMetadata();
				});
			});
		} catch {
			setting.setDesc("Repository in owner/repo form, or blank for all.");
			setting.addText((text) => {
				text.setValue(this.repo).onChange((value) => {
					this.repo = value.trim();
					this.updatePreview();
				});
			});
			setting.addExtraButton((button) => {
				button
					.setIcon("refresh-cw")
					.setTooltip("Load labels and milestones")
					.onClick(() => void this.renderMetadata());
			});
		}
	}

	/**
	 * Rebuild the label/milestone section for the current repo. A repo-scoped
	 * query gets colour chips and a milestone dropdown fetched from the repo; a
	 * global query (or a repo whose metadata can't be loaded) falls back to
	 * free-text fields so a query can still be built. Guards against a repo change
	 * that lands while the request is in flight.
	 */
	private async renderMetadata(): Promise<void> {
		const container = this.metaEl;
		if (!container) {
			return;
		}
		this.selectedLabels.clear();
		this.milestone = "";
		container.empty();

		const parsed = splitRepo(this.repo);
		if (!parsed) {
			// Global search — no single repo to enumerate labels/milestones from.
			this.renderLabelTextOption(container);
			this.renderMilestoneTextOption(container);
			this.updatePreview();
			return;
		}

		const repoAtFetch = this.repo;
		container.createDiv({
			cls: "gitea-search-wizard__notice",
			text: "Loading labels and milestones…",
		});
		let labels: GiteaLabel[];
		let milestones: GiteaMilestoneListItem[];
		try {
			[labels, milestones] = await Promise.all([
				this.plugin.fetchLabels(this.repo),
				this.plugin.fetchMilestones(this.repo),
			]);
		} catch {
			if (this.repo !== repoAtFetch) {
				return; // A newer render superseded this one.
			}
			// Couldn't load metadata — let the author type names by hand.
			container.empty();
			this.renderLabelTextOption(container);
			this.renderMilestoneTextOption(container);
			this.updatePreview();
			return;
		}
		if (this.repo !== repoAtFetch) {
			return; // A newer render superseded this one.
		}

		this.labels = labels;
		this.milestones = milestones;

		container.empty();
		this.renderLabelChips(container);
		this.renderMilestoneDropdown(container);
		this.updatePreview();
	}

	/**
	 * Render the repo's labels as a wrapping grid of toggleable colour chips,
	 * mirroring the new-issue modal. Tapping a chip flips its name in
	 * {@link selectedLabels} and refreshes the preview.
	 */
	private renderLabelChips(container: HTMLElement): void {
		new Setting(container).setName("Labels").setHeading();
		if (this.labels.length === 0) {
			container.createDiv({
				cls: "gitea-search-wizard__notice",
				text: "This repository has no labels.",
			});
			return;
		}
		const grid = container.createDiv({ cls: "gitea-new-issue__labels" });
		for (const label of this.labels) {
			const chip = grid.createEl("button", {
				cls: "gitea-new-issue__label",
				text: label.name,
			});
			chip.type = "button";
			chip.style.setProperty("--gitea-label-bg", `#${label.color}`);
			chip.style.setProperty("--gitea-label-fg", labelTextColor(label.color));
			const sync = () => {
				const selected = this.selectedLabels.has(label.name);
				chip.toggleClass("is-selected", selected);
				chip.setAttr("aria-pressed", selected ? "true" : "false");
			};
			sync();
			chip.addEventListener("click", () => {
				if (this.selectedLabels.has(label.name)) {
					this.selectedLabels.delete(label.name);
				} else {
					this.selectedLabels.add(label.name);
				}
				sync();
				this.updatePreview();
			});
		}
	}

	private renderMilestoneDropdown(container: HTMLElement): void {
		new Setting(container).setName("Milestone").addDropdown((dropdown) => {
			dropdown.addOption("", "None");
			for (const milestone of this.milestones) {
				dropdown.addOption(milestone.title, milestone.title);
			}
			dropdown.setValue("");
			dropdown.onChange((value) => {
				this.milestone = value;
				this.updatePreview();
			});
		});
	}

	private renderLabelTextOption(container: HTMLElement): void {
		new Setting(container)
			.setName("Labels")
			.setDesc("Comma-separated label names.")
			.addText((text) => {
				text.setValue(this.labelsText).onChange((value) => {
					this.labelsText = value;
					this.updatePreview();
				});
			});
	}

	private renderMilestoneTextOption(container: HTMLElement): void {
		new Setting(container)
			.setName("Milestones")
			.setDesc("Comma-separated milestone names.")
			.addText((text) => {
				text.setValue(this.milestonesText).onChange((value) => {
					this.milestonesText = value;
					this.updatePreview();
				});
			});
	}

	/** Drop the built `gitea-search` block in at the cursor and close. */
	private submit(): void {
		insertSearchBlock(this.editor, this.currentQuery());
		this.close();
	}
}

/**
 * Form-driven builder for a `gitea-graph` block (issue #43). Remembering the
 * block's `key: value` syntax — especially that a graph is scoped to a *set* of
 * milestones — is the friction this removes: pick a repo, add one or more
 * milestones from a dropdown (and optional labels), choose
 * state/keyword/limit/orientation, and watch the block update live before
 * dropping it in. Mirrors {@link SearchQueryWizardModal}; the headline
 * difference is a multi-select milestone picker (a dropdown that adds to a set,
 * the primary scoping key) and a layout *direction* in place of the search
 * layout. Reuses {@link buildGraphBlock} so the preview and the inserted block
 * are byte-for-byte identical.
 */
class GraphQueryWizardModal extends Modal {
	private repo: string;
	/** Graphs default to `all` so completed blockers still establish order (#39). */
	private state = "all";
	/** Selected label *names* in repo-scoped mode (chip toggles). */
	private selectedLabels = new Set<string>();
	/** Comma-separated label names in global mode (no repo to enumerate). */
	private labelsText = "";
	/** Selected milestone *names* in repo-scoped mode — the set to graph. */
	private selectedMilestones = new Set<string>();
	/** Comma-separated milestone names in global mode. */
	private milestonesText = "";
	private q = "";
	private limit = SEARCH_MAX_LIMIT;
	private direction: GraphDirection = "TB";

	private labels: GiteaLabel[] = [];
	private milestones: GiteaMilestoneListItem[] = [];

	private repoSetting: Setting | null = null;
	private metaEl: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;

	constructor(
		private readonly plugin: GiteaCardsPlugin,
		private readonly editor: Editor
	) {
		super(plugin.app);
		// Default to the repo of the last issue created here, falling back to the
		// configured default; an empty value means a global, cross-repo graph.
		this.repo = plugin.settings.lastRepo || plugin.settings.defaultRepo;
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("Build graph view");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gitea-search-wizard");

		// Repo picker — populated asynchronously below.
		this.repoSetting = new Setting(contentEl).setName("Repository");

		// Milestones / labels depend on the repo; (re)built here. Rendered right
		// after the repo so the milestone set — the point of a graph — leads.
		this.metaEl = contentEl.createDiv();

		new Setting(contentEl)
			.setName("State")
			.setDesc("Which issues to include. All keeps completed blockers visible.")
			.addDropdown((dropdown) => {
				dropdown.addOption("open", "Open");
				dropdown.addOption("closed", "Closed");
				dropdown.addOption("all", "All");
				dropdown.setValue(this.state);
				dropdown.onChange((value) => {
					this.state = value;
					this.updatePreview();
				});
			});

		new Setting(contentEl)
			.setName("Keyword")
			.setDesc("Free-text match on issue title and body.")
			.addText((text) => {
				text.setPlaceholder("Optional").onChange((value) => {
					this.q = value;
					this.updatePreview();
				});
			});

		new Setting(contentEl)
			.setName("Limit")
			.setDesc(`Maximum number of nodes (max ${SEARCH_MAX_LIMIT}).`)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = String(SEARCH_MAX_LIMIT);
				text.setValue(String(this.limit)).onChange((value) => {
					const parsed = Number.parseInt(value, 10);
					this.limit =
						Number.isFinite(parsed) && parsed > 0
							? Math.min(parsed, SEARCH_MAX_LIMIT)
							: SEARCH_MAX_LIMIT;
					this.updatePreview();
				});
			});

		new Setting(contentEl)
			.setName("Direction")
			.setDesc("Orientation of the dependency layers.")
			.addDropdown((dropdown) => {
				dropdown.addOption("TB", "Top to bottom");
				dropdown.addOption("LR", "Left to right");
				dropdown.setValue(this.direction);
				dropdown.onChange((value) => {
					this.direction = value as GraphDirection;
					this.updatePreview();
				});
			});

		new Setting(contentEl).setName("Preview").setHeading();
		this.previewEl = contentEl.createEl("pre", {
			cls: "gitea-search-wizard__preview",
		});

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText("Insert")
				.setCta()
				.onClick(() => this.submit());
		});

		// Insert with Ctrl/Cmd+Enter so the form is fully keyboard-driven, matching
		// the search and new-issue modals. Scope is auto-popped on close.
		this.scope.register(["Mod"], "Enter", (event) => {
			event.preventDefault();
			this.submit();
			return false;
		});

		await this.renderRepoControl();
		await this.renderMetadata();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * The query described by the current control state. Label/milestone sources
	 * switch on whether the repo resolves to an `owner/repo`: chip selections when
	 * scoped, comma-separated text in the global fallback.
	 */
	private currentQuery(): GraphQuery {
		const scoped = splitRepo(this.repo) !== null;
		return {
			repo: this.repo.trim() || null,
			state: this.state,
			labels: scoped ? [...this.selectedLabels] : splitList(this.labelsText),
			milestones: scoped
				? [...this.selectedMilestones]
				: splitList(this.milestonesText),
			q: this.q.trim() || null,
			limit: this.limit,
			direction: this.direction,
		};
	}

	/** Re-render the live block preview from the current control state. */
	private updatePreview(): void {
		this.previewEl?.setText(buildGraphBlock(this.currentQuery()).trimEnd());
	}

	/**
	 * Fill the repo picker. Offers a dropdown of repos the token can see plus an
	 * "all repositories" option for a global graph; if the list can't be fetched,
	 * falls back to a free-text field plus a reload button. Mirrors the search
	 * wizard's repo control.
	 */
	private async renderRepoControl(): Promise<void> {
		const setting = this.repoSetting;
		if (!setting) {
			return;
		}
		try {
			const repos = await this.plugin.fetchRepos();
			const options = [
				...new Set([this.repo, ...repos].filter((slug) => slug.length > 0)),
			];
			setting.setDesc("Repository to graph, or all repositories.");
			setting.addDropdown((dropdown) => {
				dropdown.addOption("", "All repositories (global)");
				for (const slug of options) {
					dropdown.addOption(slug, slug);
				}
				dropdown.setValue(this.repo);
				dropdown.onChange((value) => {
					this.repo = value;
					void this.renderMetadata();
				});
			});
		} catch {
			setting.setDesc("Repository in owner/repo form, or blank for all.");
			setting.addText((text) => {
				text.setValue(this.repo).onChange((value) => {
					this.repo = value.trim();
					this.updatePreview();
				});
			});
			setting.addExtraButton((button) => {
				button
					.setIcon("refresh-cw")
					.setTooltip("Load milestones and labels")
					.onClick(() => void this.renderMetadata());
			});
		}
	}

	/**
	 * Rebuild the milestone/label section for the current repo. A repo-scoped
	 * query gets a milestone dropdown (multi-select — a graph spans a *set*) and
	 * label chips fetched from the repo; a global query (or a repo whose metadata can't
	 * be loaded) falls back to free-text fields so a query can still be built.
	 * Guards against a repo change that lands while the request is in flight.
	 */
	private async renderMetadata(): Promise<void> {
		const container = this.metaEl;
		if (!container) {
			return;
		}
		this.selectedLabels.clear();
		this.selectedMilestones.clear();
		container.empty();

		const parsed = splitRepo(this.repo);
		if (!parsed) {
			// Global graph — no single repo to enumerate milestones/labels from.
			this.renderMilestoneTextOption(container);
			this.renderLabelTextOption(container);
			this.updatePreview();
			return;
		}

		const repoAtFetch = this.repo;
		container.createDiv({
			cls: "gitea-search-wizard__notice",
			text: "Loading milestones and labels…",
		});
		let labels: GiteaLabel[];
		let milestones: GiteaMilestoneListItem[];
		try {
			[labels, milestones] = await Promise.all([
				this.plugin.fetchLabels(this.repo),
				this.plugin.fetchMilestones(this.repo),
			]);
		} catch {
			if (this.repo !== repoAtFetch) {
				return; // A newer render superseded this one.
			}
			// Couldn't load metadata — let the author type names by hand.
			container.empty();
			this.renderMilestoneTextOption(container);
			this.renderLabelTextOption(container);
			this.updatePreview();
			return;
		}
		if (this.repo !== repoAtFetch) {
			return; // A newer render superseded this one.
		}

		this.labels = labels;
		this.milestones = milestones;

		container.empty();
		this.renderMilestonePicker(container);
		this.renderLabelChips(container);
		this.updatePreview();
	}

	/**
	 * Render the milestone selector for the current repo. Unlike the search
	 * wizard's single-select dropdown, a graph can span several milestones, so the
	 * dropdown *adds* a milestone to {@link selectedMilestones} and the chosen set
	 * is listed below as removable chips. Owns a dedicated sub-container so it can
	 * re-render itself in place — keeping the dropdown's options in sync with the
	 * set (an added milestone drops out of the list) — without rebuilding the rest
	 * of the metadata section.
	 */
	private renderMilestonePicker(container: HTMLElement): void {
		new Setting(container).setName("Milestones").setHeading();
		if (this.milestones.length === 0) {
			container.createDiv({
				cls: "gitea-search-wizard__notice",
				text: "This repository has no milestones.",
			});
			return;
		}
		this.renderMilestoneControls(container.createDiv());
	}

	/**
	 * (Re)build the milestone dropdown plus the selected-set chips inside `section`,
	 * which {@link renderMilestonePicker} owns. Called again on every add/remove so
	 * the dropdown only offers milestones not already in the set.
	 */
	private renderMilestoneControls(section: HTMLElement): void {
		section.empty();
		const remaining = this.milestones.filter(
			(milestone) => !this.selectedMilestones.has(milestone.title)
		);
		new Setting(section)
			.setName("Add milestone")
			.setDesc("Pick a milestone to add. A graph can span several.")
			.addDropdown((dropdown) => {
				dropdown.addOption(
					"",
					remaining.length > 0 ? "Choose a milestone…" : "All milestones added"
				);
				for (const milestone of remaining) {
					dropdown.addOption(milestone.title, milestone.title);
				}
				dropdown.setValue("");
				dropdown.setDisabled(remaining.length === 0);
				dropdown.onChange((value) => {
					if (!value) {
						return;
					}
					this.selectedMilestones.add(value);
					this.renderMilestoneControls(section);
					this.updatePreview();
				});
			});

		if (this.selectedMilestones.size === 0) {
			return;
		}
		const grid = section.createDiv({ cls: "gitea-new-issue__labels" });
		for (const title of this.selectedMilestones) {
			const chip = grid.createEl("button", {
				cls: "gitea-new-issue__label is-selected",
			});
			chip.type = "button";
			chip.setAttr("aria-label", `Remove ${title}`);
			chip.createSpan({ text: title });
			chip.createSpan({ cls: "gitea-new-issue__label-remove", text: "✕" });
			chip.addEventListener("click", () => {
				this.selectedMilestones.delete(title);
				this.renderMilestoneControls(section);
				this.updatePreview();
			});
		}
	}

	/**
	 * Render the repo's labels as a wrapping grid of toggleable colour chips,
	 * mirroring the search wizard. Tapping a chip flips its name in
	 * {@link selectedLabels} and refreshes the preview.
	 */
	private renderLabelChips(container: HTMLElement): void {
		new Setting(container).setName("Labels").setHeading();
		if (this.labels.length === 0) {
			container.createDiv({
				cls: "gitea-search-wizard__notice",
				text: "This repository has no labels.",
			});
			return;
		}
		const grid = container.createDiv({ cls: "gitea-new-issue__labels" });
		for (const label of this.labels) {
			const chip = grid.createEl("button", {
				cls: "gitea-new-issue__label",
				text: label.name,
			});
			chip.type = "button";
			chip.style.setProperty("--gitea-label-bg", `#${label.color}`);
			chip.style.setProperty("--gitea-label-fg", labelTextColor(label.color));
			const sync = () => {
				const selected = this.selectedLabels.has(label.name);
				chip.toggleClass("is-selected", selected);
				chip.setAttr("aria-pressed", selected ? "true" : "false");
			};
			sync();
			chip.addEventListener("click", () => {
				if (this.selectedLabels.has(label.name)) {
					this.selectedLabels.delete(label.name);
				} else {
					this.selectedLabels.add(label.name);
				}
				sync();
				this.updatePreview();
			});
		}
	}

	private renderMilestoneTextOption(container: HTMLElement): void {
		new Setting(container)
			.setName("Milestones")
			.setDesc("Comma-separated milestone names.")
			.addText((text) => {
				text.setValue(this.milestonesText).onChange((value) => {
					this.milestonesText = value;
					this.updatePreview();
				});
			});
	}

	private renderLabelTextOption(container: HTMLElement): void {
		new Setting(container)
			.setName("Labels")
			.setDesc("Comma-separated label names.")
			.addText((text) => {
				text.setValue(this.labelsText).onChange((value) => {
					this.labelsText = value;
					this.updatePreview();
				});
			});
	}

	/** Drop the built `gitea-graph` block in at the cursor and close. */
	private submit(): void {
		insertGraphBlock(this.editor, this.currentQuery());
		this.close();
	}
}

/**
 * Autocomplete for the accent-colour "add repository" field (issue #29).
 * Suggests repo slugs the token can see — served through the plugin's cached
 * {@link GiteaCardsPlugin.loadRepoList} so keystrokes coalesce to one request —
 * filtered by what's typed and minus any repo that already has an accent.
 */
class RepoInputSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly plugin: GiteaCardsPlugin,
		private readonly taken: () => Record<string, string>
	) {
		super(app, inputEl);
	}

	protected async getSuggestions(query: string): Promise<string[]> {
		const taken = this.taken();
		const needle = query.trim().toLowerCase();
		const repos = await this.plugin.loadRepoList();
		return repos
			.filter((repo) => !taken[repo])
			.filter((repo) => repo.toLowerCase().includes(needle));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}
}

class GiteaCardsSettingTab extends PluginSettingTab {
	plugin: GiteaCardsPlugin;

	constructor(app: App, plugin: GiteaCardsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Gitea base URL")
			.setDesc(
				"Public, globally reachable URL. A local-network or remote address is a manual fallback. Card links are built from this URL."
			)
			.addText((text) =>
				text
					.setPlaceholder("https://gitea.example.com")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default repository")
			.setDesc(
				"Used by the new-issue flow and bare references, in owner/repo form."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.defaultRepo)
					.onChange(async (value) => {
						this.plugin.settings.defaultRepo = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Inline keyword")
			.setDesc(
				"Trigger word for the inline reference syntax, placed before owner/repo:#123."
			)
			.addText((text) =>
				text
					.setPlaceholder("GITEA")
					.setValue(this.plugin.settings.keyword)
					.onChange(async (value) => {
						this.plugin.settings.keyword =
							value.trim() || DEFAULT_SETTINGS.keyword;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("In-progress label")
			.setDesc(
				"Label name that marks an issue as in progress. An open issue carrying it shows an amber dot and badge on its inline chip. Leave empty to disable."
			)
			.addText((text) =>
				text
					.setPlaceholder("In-progress")
					.setValue(this.plugin.settings.inProgressLabel)
					.onChange(async (value) => {
						this.plugin.settings.inProgressLabel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Refresh interval")
			.setDesc(
				`How often visible cards refresh, in seconds. Floored at ${MIN_REFRESH_SECONDS} seconds.`
			)
			.addText((text) =>
				text
					.setPlaceholder("60")
					.setValue(String(this.plugin.settings.refreshIntervalSeconds))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.refreshIntervalSeconds =
							Number.isFinite(parsed)
								? Math.max(MIN_REFRESH_SECONDS, parsed)
								: DEFAULT_SETTINGS.refreshIntervalSeconds;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Description truncation length")
			.setDesc("Maximum characters of issue body shown on a card.")
			.addText((text) =>
				text
					.setPlaceholder("160")
					.setValue(String(this.plugin.settings.truncationLength))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.truncationLength =
							Number.isFinite(parsed) && parsed > 0
								? parsed
								: DEFAULT_SETTINGS.truncationLength;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Comment preview count")
			.setDesc(
				"Number of recent comments shown when a card's comment thread is expanded."
			)
			.addText((text) =>
				text
					.setPlaceholder("3")
					.setValue(String(this.plugin.settings.commentPreviewCount))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.commentPreviewCount =
							Number.isFinite(parsed) && parsed > 0
								? Math.min(parsed, COMMENTS_MAX_PREVIEW)
								: DEFAULT_SETTINGS.commentPreviewCount;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show images in comments")
			.setDesc(
				"Load images pasted into comments inline in expanded threads. Off by default — when off, comments stay text-only. Images are fetched with your token, so private and access-gated attachments load; click one to open it full size."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showCommentImages)
					.onChange(async (value) => {
						this.plugin.settings.showCommentImages = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show attachments")
			.setDesc(
				"Show an attachment strip — image thumbnails and file chips — under single issue cards. Off by default. When on, each single issue card makes one extra request for its attachments; list blocks are unaffected and stay one request per card. Click a thumbnail to open it full size."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showAttachments)
					.onChange(async (value) => {
						this.plugin.settings.showAttachments = value;
						await this.plugin.saveSettings();
					})
			);

		this.renderAccentSettings(containerEl);

		new Setting(containerEl).setName("Credentials").setHeading();

		this.addSecretSetting(
			containerEl,
			"Gitea API token",
			"Personal access token with write:issue and read:repository scope. Stored in plaintext in this vault's data.json.",
			SECRET_KEYS.pat
		);

		this.addSecretSetting(
			containerEl,
			"Cloudflare Access client ID",
			"Service-token client ID. Sent only when the base URL is a public host behind Cloudflare Access — ignored on LAN or Tailscale addresses.",
			SECRET_KEYS.cfClientId
		);

		this.addSecretSetting(
			containerEl,
			"Cloudflare Access client secret",
			"Service-token client secret. Shown only once at creation in Cloudflare Zero Trust.",
			SECRET_KEYS.cfClientSecret
		);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc(
				"Query the server with the settings above to confirm the base URL and token work."
			)
			.addButton((button) =>
				button.setButtonText("Test connection").onClick(async () => {
					button.setDisabled(true).setButtonText("Testing…");
					try {
						const message = await this.plugin.testConnection();
						new Notice(message);
					} catch (error) {
						const message =
							error instanceof Error
								? error.message
								: "Connection test failed.";
						new Notice(`Connection failed: ${message}`);
					} finally {
						button.setDisabled(false).setButtonText("Test connection");
					}
				})
			);
	}

	/**
	 * Render the per-project accent-colour section (issue #19): a heading, the
	 * list of configured repos, and an "add repository" row below it. The list
	 * lives in its own container so add/remove can re-render just the rows (via
	 * {@link renderAccentRows}) without re-running the whole settings tab.
	 */
	private renderAccentSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Repository accent colours").setHeading();

		const listEl = containerEl.createDiv();
		this.renderAccentRows(listEl);

		let pending = "";
		let input: TextComponent | null = null;
		new Setting(containerEl)
			.setName("Add repository")
			.setDesc("Assign an accent colour to a repository, in owner/repo form.")
			.addText((text) => {
				input = text;
				text.setPlaceholder("Owner/repo").onChange((value) => {
					pending = value.trim();
				});
				// Autocomplete repo slugs the token can see (issue #29), skipping
				// any repo that already has an accent. Selecting one fills the
				// field and primes the add button.
				const suggest = new RepoInputSuggest(
					this.app,
					text.inputEl,
					this.plugin,
					() => this.plugin.settings.repoAccents
				);
				suggest.onSelect((value) => {
					pending = value;
					text.setValue(value);
					suggest.close();
				});
			})
			.addButton((button) =>
				button.setButtonText("Add").onClick(async () => {
					if (!splitRepo(pending)) {
						new Notice("Enter a repository in owner/repo form.");
						return;
					}
					if (this.plugin.settings.repoAccents[pending]) {
						new Notice("That repository already has an accent colour.");
						return;
					}
					this.plugin.settings.repoAccents[pending] = DEFAULT_ACCENT_COLOR;
					await this.plugin.saveSettings();
					this.renderAccentRows(listEl);
					pending = "";
					input?.setValue("");
				})
			);
	}

	/**
	 * (Re)render one colour-picker row per configured repo into `listEl`,
	 * replacing whatever was there. Each row carries a remove button; editing a
	 * colour saves immediately, removing one re-renders the list in place.
	 */
	private renderAccentRows(listEl: HTMLElement): void {
		listEl.empty();
		const accents = this.plugin.settings.repoAccents;
		const repos = Object.keys(accents).sort();
		if (repos.length === 0) {
			new Setting(listEl).setDesc(
				"No accent colours set. Add a repository below to tint its cards with a subtle coloured left border."
			);
			return;
		}
		for (const repo of repos) {
			new Setting(listEl)
				.setName(repo)
				.addColorPicker((picker) =>
					picker.setValue(accents[repo]).onChange(async (value) => {
						this.plugin.settings.repoAccents[repo] = value;
						await this.plugin.saveSettings();
					})
				)
				.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip("Remove accent colour")
						.onClick(async () => {
							delete this.plugin.settings.repoAccents[repo];
							await this.plugin.saveSettings();
							this.renderAccentRows(listEl);
						})
				);
		}
	}

	/**
	 * Render a masked setting row backed by secretStorage. The field shows a
	 * placeholder when a secret is already stored and only writes on change, so
	 * the stored secret is never read back into the DOM.
	 */
	private addSecretSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		secretKey: string
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		setting.addText((text) => {
			text.inputEl.type = "password";
			text.setPlaceholder("Stored in data.json");
			void this.plugin.getSecret(secretKey).then((existing) => {
				if (existing) {
					text.setPlaceholder("•••••• (stored)");
				}
			});
			text.onChange(async (value) => {
				try {
					await this.plugin.setSecret(secretKey, value.trim());
				} catch (error) {
					// Surface any persistence failure instead of dropping the
					// secret silently.
					const message =
						error instanceof Error ? error.message : String(error);
					new Notice(`Could not save "${name}": ${message}`);
				}
			});
		});
	}
}
