import { ButtonComponent, Component, Editor, ExtraButtonComponent, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, MarkdownView, Menu, Notice, Plugin, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { AuthedImage, CacheLoadResult, CardActions, CommentPreviewOptions, DEFAULT_SETTINGS, GiteaAsset, GiteaCardsSettings, GiteaComment, GiteaIssue, GiteaLabel, GiteaMilestoneDetail, GiteaMilestoneListItem, GiteaRequestError, InlineIssueSummary, IssueLoadResult, IssueRef, MIN_REFRESH_SECONDS, SearchResultItem } from "./types";
import { CoalescingCache, IssueCache } from "./cache";
import { attachmentMarkdown, buildInlineChipReference, buildIssueUrl, buildRepoUrl, chipToCardReplacement, createChipElement, defaultImageName, formatRelativeTime, initialsFromLogin, inlineChipReferencePattern, insertAtCursor, insertIssueCard, isExportingToPdf, isImageAsset, isInProgress, labelTextColor, lineEndOffset, lineStartOffset, parseBlockedByLabel, parseIssueBlock, parseIssueUrl, resolveImageSrc, splitRepo, stripMarkdown, truncate } from "./parse";
import { GraphData, GraphNode, GraphQuery, MilestoneQuery, SearchQuery, assignGraphLayers, buildMilestoneUrl, graphQueryKey, graphTitle, milestoneProgressPercent, milestoneQueryKey, parseGraphQuery, parseMilestoneQuery, parseSearchQuery, searchQueryKey } from "./query";
import { GiteaClient } from "./client";
import { BlockChild, IssueCardChild } from "./render/blocks";
import { InlineChipChild } from "./render/chips";
import { inlineChipEditorExtension } from "./editor/chip-widget";
import { GiteaInlineSuggest } from "./editor/inline-suggest";
import { ImageLightboxModal } from "./modals/image-lightbox";
import { InsertIssueModal } from "./modals/insert-issue";
import { NewIssueModal } from "./modals/new-issue";
import { SearchQueryWizardModal } from "./modals/search-wizard";
import { GraphQueryWizardModal } from "./modals/graph-wizard";
import { GiteaCardsSettingTab } from "./modals/settings-tab";

/**
 * Monotonic counter giving each rendered graph's arrowhead marker a unique id,
 * so two graphs on one note never share (and clobber) a `<marker>` definition.
 */
export let graphRenderSeq = 0;
export default class GiteaCardsPlugin extends Plugin {
	settings: GiteaCardsSettings = DEFAULT_SETTINGS;

	/**
	 * The Gitea HTTP layer (issue #76). The plugin holds one instance and
	 * delegates every REST call to it; the caches below route their loaders
	 * through it. Declared before the caches so it is initialised first.
	 */
	readonly client: GiteaClient = new GiteaClient(this);

	/**
	 * Shared cache/coalescer for every card on screen. Created in `onload` so
	 * each plugin lifecycle starts with an empty cache.
	 */
	cache: IssueCache = new IssueCache((ref) => this.client.fetchIssue(ref));

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
			(ref) => this.client.fetchComments(ref)
		);

	/**
	 * Shared cache/coalescer for `gitea-search` blocks, keyed by the query. Reuses
	 * the same throttle/backoff/stale machinery as {@link cache} so duplicate
	 * search blocks coalesce to one request per interval.
	 */
	searchCache: CoalescingCache<SearchQuery, SearchResultItem[]> =
		new CoalescingCache(searchQueryKey, (query) =>
			this.client.fetchSearchIssues(query)
		);

	/**
	 * Shared cache/coalescer for `gitea-milestone` blocks, keyed by repo+name.
	 * Reuses the same throttle/backoff/stale lifecycle as the other caches.
	 */
	milestoneCache: CoalescingCache<MilestoneQuery, GiteaMilestoneDetail> =
		new CoalescingCache(milestoneQueryKey, (query) =>
			this.client.fetchMilestone(query)
		);

	/**
	 * Shared cache/coalescer for `gitea-graph` blocks, keyed by the query. One
	 * graph fetch fans out to the scoped issue list plus a per-issue dependency
	 * call, so wrapping the whole thing in the same throttle/backoff/stale
	 * lifecycle keeps duplicate graphs (and the refresh interval) honest (#39).
	 */
	graphCache: CoalescingCache<GraphQuery, GraphData> = new CoalescingCache(
		graphQueryKey,
		(query) => this.client.fetchGraph(query)
	);

	/**
	 * Cache/coalescer for the inline repo picker (F6 stage 1). Keyed by a single
	 * constant — there is only one repo list per token — so the refresh-interval
	 * freshness window keeps keystroke-driven lookups off the network.
	 */
	repoListCache: CoalescingCache<null, string[]> = new CoalescingCache(
		() => "user-repos",
		() => this.client.fetchRepos()
	);

	/**
	 * Cache/coalescer for the inline issue picker (F6 stage 2), keyed by
	 * `owner/repo`. Each repo's issue list is fetched once per interval and
	 * filtered client-side, so typing a number/title costs no extra request.
	 */
	inlineIssueCache: CoalescingCache<string, InlineIssueSummary[]> =
		new CoalescingCache(
			(repo) => repo,
			(repo) => this.client.fetchInlineIssues(repo)
		);

	/**
	 * Cache/coalescer for the per-repo write check that scope-gates the on-card
	 * quick actions (F7), keyed by `owner/repo`. One probe per repo per interval
	 * across every card on that repo, reusing the same throttle/backoff lifecycle.
	 */
	repoWriteCache: CoalescingCache<string, boolean> = new CoalescingCache(
		(repo) => repo,
		(repo) => this.client.fetchRepoCanWrite(repo)
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
		(url) => this.client.fetchAuthedImage(url)
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
		(ref) => this.client.fetchIssueAssets(ref)
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
				const exporting = isExportingToPdf(el);
				const child = new IssueCardChild(
					el,
					this,
					block.ref,
					ctx.sourcePath,
					block.comments,
					exporting,
					ctx
				);
				ctx.addChild(child);
				// Export-to-PDF snapshots the DOM synchronously right after this
				// callback returns (issue #66). Obsidian awaits a code-block
				// processor that returns a Promise, so on export we hand back a
				// promise that resolves only once the issue and (if expanded) the
				// comment thread are painted — the PDF then captures a finished
				// card instead of "Loading…". Live preview returns void, so its
				// fire-and-forget refresh is untouched.
				if (exporting) {
					return child.hydrateForExport();
				}
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
				ctx.addChild(
					new BlockChild(el, this, query, {
						loadingText: "Loading issues…",
						cache: this.searchCache,
						render: (resultEl, resultQuery, result, refreshNow) =>
							this.renderSearchResult(
								resultEl,
								resultQuery,
								result,
								refreshNow
							),
					})
				);
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
				ctx.addChild(
					new BlockChild(el, this, query, {
						loadingText: "Loading milestone…",
						cache: this.milestoneCache,
						render: (resultEl, resultQuery, result) =>
							this.renderMilestoneResult(resultEl, resultQuery, result),
					})
				);
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
				ctx.addChild(
					new BlockChild(el, this, query, {
						loadingText: "Loading graph…",
						cache: this.graphCache,
						render: (resultEl, resultQuery, result, refreshNow) =>
							this.renderGraphResult(
								resultEl,
								resultQuery,
								result,
								refreshNow
							),
					})
				);
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
		commentPreview?: CommentPreviewOptions,
		// On an Export-to-PDF pass the returned Promise resolves only once the
		// comment thread has fully painted, so the caller can await it (issue #66).
		exporting = false
	): Promise<void> | void {
		el.empty();
		if (result.value) {
			// `actions` is passed even on a stale (offline) card so the manual
			// refresh button stays available to retry; the write-gated quick
			// actions inside are themselves dropped on a stale card by
			// renderIssueCard (they would only fail without a live server).
			return this.renderIssueCard(
				el,
				ref,
				result.value,
				result.stale,
				actions,
				commentPreview,
				exporting
			);
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
			// Fire-and-forget: search-result cards never expand a thread, so the
			// export return path is unused here. (#66)
			void this.renderIssueCard(container, item.ref, item.issue, false);
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
			code.replaceWith(this.createInlineChip(ref, ctx, el));
		}
	}

	/**
	 * Build one inline chip — `#123 ●` linked to the issue — and attach a
	 * {@link InlineChipChild} that lazily fills the title (hover preview) and
	 * colours the state dot from the shared cache.
	 */
	private createInlineChip(
		ref: IssueRef,
		ctx: MarkdownPostProcessorContext,
		sectionEl: HTMLElement
	): HTMLAnchorElement {
		const chip = createChipElement(
			this.settings.baseUrl,
			ref,
			this.settings.repoAccents[`${ref.owner}/${ref.repo}`]
		);
		// `sectionEl` (the post-processor's block root) is what carries reliable
		// section info at right-click time — the replaced chip anchor does not — so
		// the "Convert to card" handler resolves the source line range through it
		// (issue #70).
		ctx.addChild(new InlineChipChild(chip, this, ref, ctx, sectionEl));
		return chip;
	}

	/**
	 * Write `replacement` over the note's `[from, to)` character range (issue #70),
	 * the shared writer behind every format conversion. When the note is the
	 * active editable view its live editor is used, so an unsaved buffer is
	 * respected rather than clobbered; every other surface (Reading view, hover
	 * preview) falls back to a direct vault write. Obsidian re-renders the touched
	 * block after either path, so the card/chip repaints on its own. Callers derive
	 * `from`/`to` only from section info or a CodeMirror position and verify the
	 * span before calling, so a stale offset no-ops rather than corrupting prose.
	 */
	async rewriteNoteRange(
		sourcePath: string,
		from: number,
		to: number,
		replacement: string
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			new Notice("Could not find this note to update.");
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file?.path === sourcePath) {
			const editor = view.editor;
			editor.replaceRange(
				replacement,
				editor.offsetToPos(from),
				editor.offsetToPos(to)
			);
			return;
		}
		await this.app.vault.process(
			file,
			(data) => data.slice(0, from) + replacement + data.slice(to)
		);
	}

	/**
	 * Convert a rendered `gitea-issue` card back into a compact inline chip in the
	 * note source (issue #70). The fenced block reports an exact line range through
	 * `getSectionInfo`, so the whole fence is replaced with the backtick token.
	 * No-ops when there is no section info (export-to-PDF, detached renders) or the
	 * range no longer holds a fence, so a stale render cannot splice mid-note.
	 */
	async convertCardToChip(
		ctx: MarkdownPostProcessorContext,
		el: HTMLElement,
		ref: IssueRef
	): Promise<void> {
		const info = ctx.getSectionInfo(el);
		if (!info) {
			return;
		}
		const from = lineStartOffset(info.text, info.lineStart);
		const to = lineEndOffset(info.text, info.lineEnd);
		if (!info.text.slice(from, to).startsWith("```")) {
			new Notice("Could not locate the card block to convert.");
			return;
		}
		await this.rewriteNoteRange(
			ctx.sourcePath,
			from,
			to,
			buildInlineChipReference(this.settings.keyword, ref)
		);
	}

	/**
	 * Convert a rendered inline chip into a `gitea-issue` card in the note source,
	 * from the Reading-view render path (issue #70). Section info gives the
	 * paragraph's line range and text but not which occurrence was clicked, so the
	 * first matching token in the section is converted and — when the paragraph
	 * holds a second identical reference — a Notice flags the ambiguity (issue #70
	 * Q3; the Live-Preview path is exact and never hits this). The line is split
	 * around the token so surrounding prose survives (issue #70 Q1).
	 */
	async convertChipToCard(
		ctx: MarkdownPostProcessorContext,
		sectionEl: HTMLElement,
		ref: IssueRef
	): Promise<void> {
		const info = ctx.getSectionInfo(sectionEl);
		if (!info) {
			return;
		}
		const token = buildInlineChipReference(this.settings.keyword, ref);
		const sectionFrom = lineStartOffset(info.text, info.lineStart);
		const sectionTo = lineEndOffset(info.text, info.lineEnd);
		const section = info.text.slice(sectionFrom, sectionTo);
		const rel = section.indexOf(token);
		if (rel === -1) {
			new Notice("Could not locate the reference to convert.");
			return;
		}
		const start = sectionFrom + rel;
		const end = start + token.length;
		const duplicated =
			section.indexOf(token, rel + token.length) !== -1;
		const lineStart = info.text.lastIndexOf("\n", start - 1) + 1;
		const before = info.text.slice(lineStart, start);
		await this.rewriteNoteRange(
			ctx.sourcePath,
			start,
			end,
			chipToCardReplacement(before, ref)
		);
		if (duplicated) {
			new Notice(
				"Converted the first matching reference in this paragraph."
			);
		}
	}

	/**
	 * Right-click menu for a Live-Preview chip: the single "Convert to card"
	 * toggle (issue #70 Q4 — no broader issue menu). The CodeMirror widget carries
	 * an exact document position, so this path is unambiguous even for duplicate
	 * references in one paragraph.
	 */
	showLiveChipMenu(
		evt: MouseEvent,
		view: EditorView,
		chip: HTMLElement,
		ref: IssueRef
	): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Convert to card")
				.setIcon("layout-grid")
				.onClick(() => this.convertLiveChipToCard(view, chip, ref))
		);
		menu.showAtMouseEvent(evt);
	}

	/**
	 * Convert a Live-Preview chip to a card by dispatching straight to the editor
	 * (issue #70). `posAtDOM` gives the chip widget's exact document offset; the
	 * span is verified to still hold the token before writing, so a shifted
	 * position aborts with a Notice instead of corrupting the note.
	 */
	private convertLiveChipToCard(
		view: EditorView,
		chip: HTMLElement,
		ref: IssueRef
	): void {
		const token = buildInlineChipReference(this.settings.keyword, ref);
		const doc = view.state.doc;
		const anchor = view.posAtDOM(chip);
		const line = doc.lineAt(anchor);
		// `posAtDOM` normally lands on the widget's start; verify the token sits
		// there, and otherwise fall back to the token's position on the widget's
		// line, so a boundary quirk aborts or self-corrects rather than splicing
		// the wrong span.
		let start = anchor;
		if (doc.sliceString(start, start + token.length) !== token) {
			const rel = line.text.indexOf(token);
			if (rel === -1) {
				new Notice("Could not locate the reference to convert.");
				return;
			}
			start = line.from + rel;
		}
		const end = start + token.length;
		const before = doc.sliceString(line.from, start);
		view.dispatch({
			changes: {
				from: start,
				to: end,
				insert: chipToCardReplacement(before, ref),
			},
		});
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
		commentPreview?: CommentPreviewOptions,
		// During Export-to-PDF the comment thread is awaited instead of
		// fire-and-forgotten, and this returns that Promise (issue #66).
		exporting = false
	): Promise<void> | void {
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
			// The milestone links to its Gitea page (issue #71) so a card can jump
			// straight to the milestone's status. Built from the configured base
			// URL via the milestone id, never the API host (the ROOT_URL caveat).
			const milestone = meta.createEl("a", {
				cls: "gitea-card__milestone",
				href: buildMilestoneUrl(
					this.settings.baseUrl,
					`${ref.owner}/${ref.repo}`,
					issue.milestone.id
				),
			});
			milestone.setAttr("target", "_blank");
			milestone.setAttr("rel", "noopener");
			milestone.setAttr(
				"aria-label",
				`Milestone ${issue.milestone.title}`
			);
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
		let threadHydration: Promise<void> | undefined;
		if (canExpandComments && commentPreview.expanded) {
			const thread = card.createDiv({ cls: "gitea-card__comments-thread" });
			// Live preview fire-and-forgets (paint "Loading…", fill later); an
			// export pass awaits the returned Promise so the thread is in the
			// snapshot (issue #66).
			threadHydration = this.renderCommentThread(
				thread,
				ref,
				commentPreview,
				exporting
			);
			if (!exporting) {
				void threadHydration;
			}
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

		// Export path only: hand the caller a Promise that resolves once the
		// thread (if any) has painted, so printToPDF snapshots a finished card.
		if (exporting) {
			return threadHydration ?? Promise.resolve();
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
		preview: CommentPreviewOptions,
		exporting = false
	): Promise<void> {
		container.createDiv({
			cls: "gitea-card__comments-loading",
			text: "Loading comments…",
		});
		const result = await this.commentsCache.load(ref, this.refreshIntervalMs);
		// The card may have been torn down (or collapsed) while in flight. During
		// an export we deliberately skip this bail: the print container Obsidian
		// is about to snapshot may read as momentarily detached, and dropping the
		// thread there is exactly the "Loading…" freeze this rescues (issue #66).
		if (!exporting && !container.isConnected) {
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
		const bodies: Array<Promise<void> | void> = [];
		for (const comment of recent) {
			bodies.push(this.renderComment(container, comment, preview));
		}
		// The comment bodies render Markdown asynchronously; on export we must
		// await them so their text is in the snapshot, not just the containers.
		if (exporting) {
			await Promise.all(bodies.map((body) => Promise.resolve(body)));
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
	): Promise<void> {
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
		// Returned so an export pass can await the async Markdown render; live
		// preview callers ignore it (fire-and-forget). (#66)
		return this.renderCommentBody(body, comment.body ?? "", preview);
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
					this.client.setIssueState(ref, isClosed ? "open" : "closed"),
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

		const milestoneButton = container.createEl("button", {
			cls: "gitea-card__action",
			text: "Milestone",
		});
		milestoneButton.setAttr("aria-label", "Set or clear the milestone");
		milestoneButton.addEventListener("click", (evt) => {
			void this.openMilestoneMenu(evt, ref, issue, actions);
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
				() => this.client.addIssueComment(ref, body),
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
			const attachment = await this.client.uploadIssueAsset(
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
			labels = await this.client.fetchLabels(`${ref.owner}/${ref.repo}`);
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
									? this.client.removeIssueLabel(ref, label.id)
									: this.client.addIssueLabels(ref, [label.id]),
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
	 * Open a menu of the repo's open milestones, ticking the one already applied.
	 * Picking one assigns it by ID; a "No milestone" item clears it (PATCH with
	 * `0`). A milestone is single-valued, so the menu closes after a pick — unlike
	 * the label menu, there's nothing to multi-select.
	 */
	private async openMilestoneMenu(
		evt: MouseEvent,
		ref: IssueRef,
		issue: GiteaIssue,
		actions: CardActions
	): Promise<void> {
		let milestones: GiteaMilestoneListItem[];
		try {
			milestones = await this.client.fetchMilestones(
				`${ref.owner}/${ref.repo}`
			);
		} catch (error) {
			new Notice(
				error instanceof Error
					? error.message
					: "Could not load milestones."
			);
			return;
		}

		const currentId = issue.milestone?.id ?? null;
		// With no open milestones and none already set, there's nothing to pick
		// or clear — say so rather than open an empty menu.
		if (milestones.length === 0 && currentId === null) {
			new Notice("This repository has no open milestones.");
			return;
		}

		const menu = new Menu();

		menu.addItem((item) => {
			item
				.setTitle("No milestone")
				.setChecked(currentId === null)
				.onClick(() => {
					if (currentId === null) {
						return;
					}
					void this.runCardAction(
						null,
						() => this.client.setIssueMilestone(ref, 0),
						actions,
						"Cleared milestone."
					);
				});
		});

		for (const milestone of milestones) {
			const isApplied = milestone.id === currentId;
			menu.addItem((item) => {
				item
					.setTitle(milestone.title)
					.setChecked(isApplied)
					.onClick(() => {
						if (isApplied) {
							return;
						}
						void this.runCardAction(
							null,
							() =>
								this.client.setIssueMilestone(
									ref,
									milestone.id
								),
							actions,
							`Set milestone “${milestone.title}”.`
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

export * from "./types";
export * from "./cache";
export * from "./parse";
export * from "./query";
export * from "./client";
