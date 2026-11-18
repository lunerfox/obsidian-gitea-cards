import { MarkdownRenderChild } from "obsidian";

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
 * Keys under which credentials are stored in {@link GiteaCardsSettings.secrets}
 * (data.json). Kept dash-namespaced (no colons) for tidiness.
 */
export const SECRET_KEYS = {
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
export interface GiteaLabel {
	id: number;
	name: string;
	/** Six-character hex without a leading `#`. */
	color: string;
}

/** Issue author. `avatar_url` is carried for future use; F1 renders initials. */
export interface GiteaUser {
	login: string;
	avatar_url?: string;
}

export interface GiteaMilestone {
	/** Gitea's milestone id — used to link a graph header's milestone (issue #47). */
	id: number;
	title: string;
}

/**
 * The subset of `GET /repos/{owner}/{repo}/milestones/{id|name}` the progress
 * block consumes. Gitea returns `open_issues`/`closed_issues` on the milestone
 * itself, so the bar needs no extra issue counting.
 */
export interface GiteaMilestoneDetail {
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
export interface GiteaIssue {
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
export interface GiteaListIssue extends GiteaIssue {
	pull_request?: unknown;
	repository?: { full_name?: string } | null;
	/**
	 * Assignees carried by the list/search endpoints (issue #62). The global
	 * search endpoint has no per-username assignee param, so an `assignee:` filter
	 * is applied client-side against this array; may be absent on older Gitea.
	 */
	assignees?: GiteaUser[] | null;
}

/**
 * The subset of `GET .../issues/{index}/comments` a thread preview consumes
 * (issue #40). The body is Markdown (Gitea comment bodies are Markdown) and is
 * rendered as such; `created_at` drives the relative timestamp.
 */
export interface GiteaComment {
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
export interface GiteaAsset {
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
export interface SearchResultItem {
	ref: IssueRef;
	issue: GiteaIssue;
}

/**
 * Wiring a card needs to render its on-card quick actions (F7). Supplied only by
 * the single-issue block (the only card backed by a per-card refresh and the
 * `owner/repo#index` cache entry an action invalidates); search/stale cards omit
 * it and render no buttons.
 */
export interface CardActions {
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
export interface CommentPreviewOptions {
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
export interface GiteaMilestoneListItem {
	id: number;
	title: string;
	state: string;
}

/** A repo as returned by `GET /user/repos`, trimmed to what the picker needs. */
export interface GiteaRepoSummary {
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
export interface GiteaRepoPermissions {
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
export type InlineSuggestion =
	| { kind: "repo"; repo: string }
	| { kind: "issue"; index: number; title: string; state: string };

/**
 * The `CreateIssueOption` body for `POST .../issues`. Note the convention the
 * plan calls out: `labels` are label **IDs** and `milestone` a milestone **ID**
 * (the inverse of the list filters, which take names) — the modal maps picker
 * selections to IDs before building this.
 */
export interface CreateIssuePayload {
	title: string;
	body: string;
	labels: number[];
	milestone?: number;
	assignees: string[];
}

/** Raised for any non-success Gitea response so the card can show one line. */
export class GiteaRequestError extends Error {
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
