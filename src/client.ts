import type GiteaCardsPlugin from "./main";
import { RequestUrlResponse, requestUrl } from "obsidian";
import { AuthedImage, CreateIssuePayload, GiteaAsset, GiteaAttachment, GiteaComment, GiteaIssue, GiteaLabel, GiteaListIssue, GiteaMilestoneDetail, GiteaMilestoneListItem, GiteaRepoPermissions, GiteaRepoSummary, GiteaRequestError, InlineIssueSummary, IssueRef, SECRET_KEYS, SearchResultItem } from "./types";
import { buildMultipart, getResponseHeader, isCloudflareBaseUrl, isInProgress, issueHasAssignee, parseBlockedByLabel } from "./parse";
import { GraphData, GraphEdge, GraphNode, GraphQuery, MilestoneQuery, SearchQuery, graphNodeId } from "./query";

/**
 * The Gitea HTTP layer, extracted from {@link GiteaCardsPlugin} (issue #76).
 * Owns every REST call: auth-header assembly, the Cloudflare 302-vs-401 error
 * disambiguation, the `type=issues` PR filtering, and the read/write/upload
 * methods. Holding it as a single instance on the plugin makes the network
 * layer mockable — a stub can stand in for a live Gitea in tests. Reads the
 * base URL and secrets from the owning plugin; behaviour is unchanged.
 */
export class GiteaClient {
	constructor(private readonly plugin: GiteaCardsPlugin) {}

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
		const pat = await this.plugin.getSecret(SECRET_KEYS.pat);
		if (pat) {
			headers.Authorization = `token ${pat}`;
		}
		if (isCloudflareBaseUrl(this.plugin.settings.baseUrl)) {
			const cfClientId = await this.plugin.getSecret(SECRET_KEYS.cfClientId);
			const cfClientSecret = await this.plugin.getSecret(SECRET_KEYS.cfClientSecret);
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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

		const hasToken = Boolean(await this.plugin.getSecret(SECRET_KEYS.pat));
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		if (query.assignee) {
			// Repo endpoint honours `assigned_by` (issue #62); the global search
			// endpoint ignores it, so fetchSearchIssues also filters client-side.
			params.set("assigned_by", query.assignee);
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
		// Gitea silently *drops* a milestone filter it can't resolve, returning the
		// whole unfiltered set rather than nothing (issue #63). A filter naming a
		// milestone that doesn't exist can never match an issue, so surface it as an
		// empty result instead of every issue in the repo. Only checkable against a
		// concrete repo; a global (cross-repo) search has no single repo to validate.
		if (query.milestones.length > 0 && query.repo) {
			const missing = await this.findMissingMilestones(
				query.repo,
				query.milestones
			);
			if (missing.length > 0) {
				return [];
			}
		}
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const assignee = query.assignee?.toLowerCase();
		const results: SearchResultItem[] = [];
		for (const item of items) {
			if (item.pull_request != null) {
				continue; // Drop PRs — list endpoints mix them in with issues.
			}
			// The global search endpoint has no assignee param, so filter here as
			// well (issue #62); harmless for repo queries already narrowed by
			// `assigned_by`.
			if (assignee && !issueHasAssignee(item, assignee)) {
				continue;
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		return query.repo ?? (this.plugin.settings.defaultRepo || null);
	}

	/** Reuse the search list machinery to fetch a graph's scoped issue set. */
	private graphToSearchQuery(query: GraphQuery): SearchQuery {
		return {
			repo: this.graphRepo(query),
			state: query.state,
			labels: query.labels,
			milestones: query.milestones,
			assignee: null,
			q: query.q,
			limit: query.limit,
			layout: "table",
		};
	}

	/**
	 * Return the subset of named milestones that don't exist in the repo. Gitea's
	 * list endpoints silently *ignore* an unknown milestone name and return the
	 * whole unfiltered set, so a typo'd or deleted milestone otherwise reads as
	 * "all issues" (issues #48, #63). One `GET .../milestones/{name}` per named
	 * milestone — a 404 means it does not exist; the `{id|name}` endpoint matches
	 * by name regardless of state, so a *completed* milestone still resolves.
	 * Shared by graph validation (which errors) and search tables (which empty).
	 */
	private async findMissingMilestones(
		repo: string,
		milestones: string[]
	): Promise<string[]> {
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		return missing;
	}

	/**
	 * Verify every milestone name a graph filters on actually exists in the repo,
	 * throwing a single {@link GiteaRequestError} naming the missing milestone(s)
	 * so a typo'd or deleted milestone errors rather than rendering every issue
	 * (issue #48).
	 */
	private async assertMilestonesExist(
		repo: string,
		milestones: string[]
	): Promise<void> {
		const missing = await this.findMissingMilestones(repo, milestones);
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
				!isClosed && isInProgress(issue, this.plugin.settings.inProgressLabel);
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
	 * Fetch a repo's labels so the modal can map picked names to the IDs the
	 * create endpoint requires (creation takes IDs, list filters take names).
	 */
	async fetchLabels(repo: string): Promise<GiteaLabel[]> {
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.repoPath(repo)}`;
		const headers = await this.buildAuthHeaders();
		const response = await requestUrl({ url, method: "GET", headers, throw: false });
		this.ensureGiteaOk(response, "Repository not found.");
		const data = response.json as GiteaRepoPermissions;
		return Boolean(data.permissions?.push || data.permissions?.admin);
	}

	/** Toggle an issue open/closed via `PATCH .../issues/{index}` with `{state}`. */
	async setIssueState(ref: IssueRef, state: "open" | "closed"): Promise<void> {
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}`;
		await this.giteaMutate(url, "PATCH", { state });
	}

	/**
	 * Set or clear an issue's milestone via `PATCH .../issues/{index}` with
	 * `{milestone}`. Takes a milestone **ID** (the same create-vs-list asymmetry
	 * as labels); pass `0` to clear the milestone, which Gitea treats as "none".
	 */
	async setIssueMilestone(ref: IssueRef, milestoneId: number): Promise<void> {
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}`;
		await this.giteaMutate(url, "PATCH", { milestone: milestoneId });
	}

	/** Post a comment via `POST .../issues/{index}/comments` with `{body}`. */
	async addIssueComment(ref: IssueRef, body: string): Promise<void> {
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
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
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/labels`;
		await this.giteaMutate(url, "POST", { labels: labelIds });
	}

	/** Remove one label via `DELETE .../issues/{index}/labels/{id}` (by ID). */
	async removeIssueLabel(ref: IssueRef, labelId: number): Promise<void> {
		const base = this.plugin.settings.baseUrl.replace(/\/+$/, "");
		const url = `${base}/api/v1/repos/${this.issuePath(ref)}/labels/${labelId}`;
		await this.giteaMutate(url, "DELETE");
	}
}
