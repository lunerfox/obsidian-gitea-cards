import { Editor } from "obsidian";
import { IssueRef } from "./types";

/** Default and hard cap for the number of cards a search block renders. */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

/** Issue states accepted by both Gitea list endpoints. */
export const SEARCH_STATES = ["open", "closed", "all"] as const;

/** The wizards' repo pickers spell an empty repo — a cross-repo query — this way. */
export const ALL_REPOS_LABEL = "All repositories (global)";

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
	/**
	 * Assignee username to filter on (issue #62). A single login: repo-scoped
	 * queries pass it server-side as `assigned_by`; global queries have no such
	 * param, so it is also matched client-side against each issue's assignees.
	 */
	assignee: string | null;
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

export function splitList(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * Split a `key: value` block body into a key→value map: trims and lowercases
 * keys, trims values, skips blank lines, and keeps only the last occurrence of
 * a repeated key. `sep === -1` (a line with no colon) is the one parse error
 * shared verbatim by `parseSearchQuery`, `parseMilestoneQuery`, and
 * `parseGraphQuery` — everything else about a line's validity is field-specific
 * and left to the caller.
 */
export function parseKeyValueBlock(source: string): {
	pairs: Map<string, string> | null;
	error: string | null;
} {
	const pairs = new Map<string, string>();
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		const sep = line.indexOf(":");
		if (sep === -1) {
			return {
				pairs: null,
				error: `Expected "key: value" lines; got "${line}".`,
			};
		}
		const key = line.slice(0, sep).trim().toLowerCase();
		const value = line.slice(sep + 1).trim();
		pairs.set(key, value);
	}
	return { pairs, error: null };
}

/** A field's `key: value` handler — mutates `query` in place, or returns an error. */
export type FieldHandler<Q> = (value: string, query: Q) => string | null;

/**
 * Looks up and runs the handler for each parsed field in source order, so the
 * first field-specific error (an unknown state, an unknown layout, …) wins —
 * matching the three parsers' pre-unification behaviour of validating inline
 * as they walked the block line by line.
 */
export function applyQueryFields<Q>(
	pairs: Map<string, string>,
	handlers: Record<string, FieldHandler<Q>>,
	query: Q
): string | null {
	for (const [key, value] of pairs) {
		const handler = handlers[key];
		if (!handler) {
			return `Unknown field "${key}".`;
		}
		const error = handler(value, query);
		if (error) {
			return error;
		}
	}
	return null;
}

/** The scoping fields `gitea-search` and `gitea-graph` blocks both accept. */
export interface ScopedQueryFields {
	repo: string | null;
	state: string;
	labels: string[];
	milestones: string[];
	q: string | null;
	limit: number;
}

/**
 * Field handlers shared by `parseSearchQuery` and `parseGraphQuery` — the two
 * parsers that scope an issue set the same way. Generic over `Q` so each caller
 * gets handlers typed to its own query interface without a cast.
 */
export function scopedQueryFieldHandlers<Q extends ScopedQueryFields>(): Record<
	string,
	FieldHandler<Q>
> {
	const repo: FieldHandler<Q> = (value, query) => {
		query.repo = value.length > 0 ? value : null;
		return null;
	};
	const state: FieldHandler<Q> = (value, query) => {
		const state = value.toLowerCase();
		if (!SEARCH_STATES.includes(state as (typeof SEARCH_STATES)[number])) {
			return `Unknown state "${value}" — use open, closed, or all.`;
		}
		query.state = state;
		return null;
	};
	const labels: FieldHandler<Q> = (value, query) => {
		query.labels = splitList(value);
		return null;
	};
	const milestones: FieldHandler<Q> = (value, query) => {
		query.milestones = splitList(value);
		return null;
	};
	const q: FieldHandler<Q> = (value, query) => {
		query.q = value.length > 0 ? value : null;
		return null;
	};
	const limit: FieldHandler<Q> = (value, query) => {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			query.limit = Math.min(parsed, SEARCH_MAX_LIMIT);
		}
		return null;
	};
	return { repo, state, label: labels, labels, milestone: milestones, milestones, q, query: q, limit };
}

/** Shared "repo: owner/repo" validator for the scoped query parsers. */
export function invalidRepoError(repo: string | null): string | null {
	if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
		return `Invalid repo "${repo}" — use owner/repo.`;
	}
	return null;
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
	const { pairs, error: splitError } = parseKeyValueBlock(source);
	if (!pairs) {
		return { query: null, error: splitError };
	}

	const query: SearchQuery = {
		repo: null,
		state: "open",
		labels: [],
		milestones: [],
		assignee: null,
		q: null,
		limit: SEARCH_DEFAULT_LIMIT,
		layout: "table",
	};

	const assignee: FieldHandler<SearchQuery> = (value, q) => {
		q.assignee = value.length > 0 ? value : null;
		return null;
	};
	const layout: FieldHandler<SearchQuery> = (value, q) => {
		const normalized = value.toLowerCase() === "card" ? "cards" : value.toLowerCase();
		if (!SEARCH_LAYOUTS.includes(normalized as SearchLayout)) {
			return `Unknown layout "${value}" — use table or cards.`;
		}
		q.layout = normalized as SearchLayout;
		return null;
	};

	const fieldError = applyQueryFields(
		pairs,
		{
			...scopedQueryFieldHandlers<SearchQuery>(),
			assignee,
			assignees: assignee,
			assigned: assignee,
			layout,
			view: layout,
		},
		query
	);
	if (fieldError) {
		return { query: null, error: fieldError };
	}

	const repoError = invalidRepoError(query.repo);
	if (repoError) {
		return { query: null, error: repoError };
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
		assignee: query.assignee,
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
	if (query.assignee) {
		lines.push(`assignee: ${query.assignee}`);
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
	const { pairs, error: splitError } = parseKeyValueBlock(source);
	if (!pairs) {
		return { query: null, error: splitError };
	}

	let repo = "";
	let milestone = "";

	for (const [key, value] of pairs) {
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
	const { pairs, error: splitError } = parseKeyValueBlock(source);
	if (!pairs) {
		return { query: null, error: splitError };
	}

	const query: GraphQuery = {
		repo: null,
		state: "all",
		labels: [],
		milestones: [],
		q: null,
		limit: SEARCH_MAX_LIMIT,
		direction: "TB",
	};

	const direction: FieldHandler<GraphQuery> = (value, q) => {
		// Tolerate Mermaid's "TD" as an alias for top-to-bottom.
		const dir = value.toUpperCase() === "TD" ? "TB" : value.toUpperCase();
		if (!GRAPH_DIRECTIONS.includes(dir as GraphDirection)) {
			return `Unknown direction "${value}" — use TB or LR.`;
		}
		q.direction = dir as GraphDirection;
		return null;
	};

	const fieldError = applyQueryFields(
		pairs,
		{
			...scopedQueryFieldHandlers<GraphQuery>(),
			direction,
			dir: direction,
		},
		query
	);
	if (fieldError) {
		return { query: null, error: fieldError };
	}

	const repoError = invalidRepoError(query.repo);
	if (repoError) {
		return { query: null, error: repoError };
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
