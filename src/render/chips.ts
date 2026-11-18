import type GiteaCardsPlugin from "../main";
import { MarkdownPostProcessorContext, MarkdownRenderChild, Menu } from "obsidian";
import { IssueRef } from "../types";
import { applyChipState, isElementVisible } from "../parse";

/**
 * Lifecycle wrapper for one inline chip. Tied to the chip element via
 * `ctx.addChild`, so its fetch is abandoned once the chip leaves the DOM. Pulls
 * the issue from the same shared cache the full cards use (one coalesced request
 * per issue per interval) to fill the hover-preview title and the state dot.
 * Like the cards, it re-pulls on the configured refresh interval so a chip's
 * state dot and title stay current without reopening the note (issue #27).
 */
export class InlineChipChild extends MarkdownRenderChild {
	constructor(
		chipEl: HTMLElement,
		private readonly plugin: GiteaCardsPlugin,
		private readonly ref: IssueRef,
		// Section context + the post-processor's block root, used to resolve the
		// chip's source position for the right-click "Convert to card" action
		// (issue #70). The replaced chip anchor cannot carry section info itself.
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly sectionEl: HTMLElement
	) {
		super(chipEl);
	}

	onload(): void {
		this.registerDomEvent(this.containerEl, "contextmenu", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Convert to card")
					.setIcon("layout-grid")
					.onClick(() =>
						void this.plugin.convertChipToCard(
							this.ctx,
							this.sectionEl,
							this.ref
						)
					)
			);
			menu.showAtMouseEvent(evt);
		});
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
