import type GiteaCardsPlugin from "../main";
import { MarkdownPostProcessorContext, MarkdownRenderChild, Menu } from "obsidian";
import { CacheLoadResult, CardActions, CommentPreviewOptions, GiteaIssue, IssueRef } from "../types";
import { CoalescingCache } from "../cache";
import { isElementVisible } from "../parse";

/**
 * Shared lifecycle wrapper for one rendered block (`gitea-issue`,
 * `gitea-search`, `gitea-milestone`, or `gitea-graph`). As a MarkdownRenderChild
 * added via `ctx.addChild`, `onload` paints the loading placeholder, starts the
 * refresh timer, and `onunload` (note scrolled off-screen, closed, or the
 * plugin unloads) tears the timer down via `registerInterval`. Only visible
 * blocks hit the network — the interval callback bails when the container
 * isn't shown (see {@link isElementVisible}) — and a response that lands after
 * the container has detached is dropped rather than painted into a dead node
 * (issue #66). `TQuery` is the cache key (an `IssueRef`, `SearchQuery`, etc.);
 * `TValue` is what the cache resolves to.
 */
export class BlockChild<TQuery, TValue> extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		protected readonly plugin: GiteaCardsPlugin,
		protected readonly query: TQuery,
		private readonly options: {
			loadingText: string;
			cache: CoalescingCache<TQuery, TValue>;
			render: (
				el: HTMLElement,
				query: TQuery,
				result: CacheLoadResult<TValue>,
				refreshNow: () => void
			) => Promise<void> | void;
		}
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.empty();
		this.containerEl.createDiv({
			cls: "gitea-card gitea-card--loading",
			text: this.options.loadingText,
		});
		void this.refresh();

		// Auto-cancelled on unload (note closed/scrolled away or plugin unload).
		// Only visible blocks hit the network; off-screen leaves are skipped.
		this.registerInterval(
			window.setInterval(() => {
				if (!isElementVisible(this.containerEl)) {
					return;
				}
				void this.refresh();
			}, this.plugin.refreshIntervalMs)
		);
	}

	/** Pull from the configured cache and rebuild via the configured render method. */
	protected async refresh(): Promise<void> {
		const result = await this.options.cache.load(
			this.query,
			this.plugin.refreshIntervalMs
		);
		// The child may have unloaded while the request was in flight.
		if (!this.containerEl.isConnected) {
			return;
		}
		await this.options.render(this.containerEl, this.query, result, () =>
			void this.refreshNow()
		);
	}

	/**
	 * Force a fresh fetch on demand (issues #36, #42) — drop the cache entry so
	 * the next load bypasses the coalescing window (and any failure backoff),
	 * then rebuild. A block's manual "Refresh" button drives this via the
	 * `refreshNow` callback handed to `render`.
	 */
	private async refreshNow(): Promise<void> {
		this.options.cache.invalidate(this.query);
		await this.refresh();
	}
}

/**
 * Lifecycle wrapper for one `gitea-issue` card — the only block with enough
 * extra behaviour (export snapshots, in-place comment editing, the right-click
 * "Convert to inline chip" menu) to need more than {@link BlockChild}'s
 * `{ loadingText, cache, render }` shape. Still delegates the shared
 * cache-load / `isConnected` / render plumbing to the base class.
 */
export class IssueCardChild extends BlockChild<IssueRef, GiteaIssue> {
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
		plugin: GiteaCardsPlugin,
		ref: IssueRef,
		private readonly sourcePath: string,
		autoExpandComments: number | null,
		// True only during an Export-to-PDF render pass — see isExportingToPdf and
		// hydrateForExport (issue #66).
		private readonly exporting = false,
		// Present for a normal render; used to resolve the block's source line
		// range for the right-click "Convert to inline chip" action (issue #70).
		// Optional so export/other callers need not thread it through.
		private readonly ctx?: MarkdownPostProcessorContext
	) {
		super(containerEl, plugin, ref, {
			loadingText: "Loading issue…",
			cache: plugin.cache,
			// Fire-and-forget in live preview; hydrateForExport() takes the awaited
			// path below instead, so the base class's refresh() isn't involved.
			render: (el, issueRef, result) =>
				plugin.renderCardResult(
					el,
					issueRef,
					result,
					this.cardActions(),
					this.commentPreviewOptions()
				),
		});
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
		// On an Export-to-PDF pass the code-block processor awaits
		// hydrateForExport() instead; skip the fire-and-forget refresh and the
		// refresh timer — there is no live, on-screen card to keep fresh, and the
		// snapshot happens once, synchronously (issue #66).
		if (this.exporting) {
			return;
		}
		this.registerFormatMenu();
		void this.refresh();

		// Auto-cancelled on unload (note closed/scrolled away or plugin unload).
		// Only visible cards hit the network; off-screen leaves are skipped. Also
		// skipped while an on-card editor is open (F7), unlike the base class's
		// plain visibility-only guard.
		this.registerInterval(
			window.setInterval(() => {
				if (this.suspended || !isElementVisible(this.containerEl)) {
					return;
				}
				void this.refresh();
			}, this.plugin.refreshIntervalMs)
		);
	}

	/**
	 * Attach the right-click "Convert to inline chip" menu to the card (issue
	 * #70). Bound on the container, which persists across the per-interval card
	 * rebuilds, and torn down with the child via `registerDomEvent`. The same card
	 * render path serves both Reading view and Live Preview, so this one handler
	 * covers both surfaces. `preventDefault`/`stopPropagation` keep CodeMirror's
	 * native context menu from opening on top in Live Preview.
	 */
	private registerFormatMenu(): void {
		if (!this.ctx) {
			return;
		}
		const ctx = this.ctx;
		this.registerDomEvent(this.containerEl, "contextmenu", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Convert to inline chip")
					.setIcon("link")
					.onClick(() =>
						void this.plugin.convertCardToChip(
							ctx,
							this.containerEl,
							this.query
						)
					)
			);
			menu.showAtMouseEvent(evt);
		});
	}

	/**
	 * Fully hydrate the card for an Export-to-PDF snapshot (issue #66). Awaits the
	 * issue, then paints and awaits the (expanded) comment thread — including each
	 * comment body's Markdown render — so the returned Promise resolves only once
	 * the finished card is in the DOM Electron is about to snapshot. Unlike
	 * {@link refresh} there is no `isConnected` guard: the export container stays
	 * attached until `printToPDF` runs, and we must paint into the very container
	 * it captures rather than bail if a transient detach is observed.
	 */
	async hydrateForExport(): Promise<void> {
		const result = await this.plugin.cache.load(
			this.query,
			this.plugin.refreshIntervalMs
		);
		await this.plugin.renderCardResult(
			this.containerEl,
			this.query,
			result,
			this.cardActions(),
			this.commentPreviewOptions(),
			true
		);
	}

	private cardActions(): CardActions {
		return {
			// A successful action invalidates this issue's cache entry and
			// rebuilds the card from a fresh fetch; the rebuild clears any open
			// editor, so refreshing is also resumed. The comments cache is
			// dropped too, so a freshly posted comment shows in the thread.
			onChanged: () => {
				this.suspended = false;
				this.plugin.cache.invalidate(this.query);
				this.plugin.commentsCache.invalidate(this.query);
				this.plugin.assetsCache.invalidate(this.query);
				void this.refresh();
			},
			setSuspended: (suspended) => {
				this.suspended = suspended;
			},
		};
	}

	private commentPreviewOptions(): CommentPreviewOptions {
		return {
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
		};
	}
}
