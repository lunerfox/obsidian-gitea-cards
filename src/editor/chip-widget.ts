import type GiteaCardsPlugin from "../main";
import { editorLivePreviewField } from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { IssueRef } from "../types";
import { applyChipState, createChipElement, inlineChipSourcePattern } from "../parse";

/**
 * Maps each Live Preview chip element to the issue it shows, so the editor
 * extension's refresh timer can re-pull and re-apply state to the chips that
 * are currently mounted (issue #27). A `WeakMap` lets entries fall away with
 * their detached chip elements — no manual cleanup on widget teardown.
 */
export const liveChipRefs = new WeakMap<HTMLElement, IssueRef>();

/**
 * Live Preview counterpart of {@link InlineChipChild}: a CodeMirror widget that
 * renders the chip in the *editing* view, which the Markdown post-processor
 * never touches. Loads the issue from the shared cache, so it shares the same
 * coalescing/freshness as every other chip and card.
 */
export class InlineChipWidget extends WidgetType {
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

	toDOM(view: EditorView): HTMLElement {
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
		// Right-click → "Convert to card" (issue #70). `posAtDOM` resolves the
		// widget's exact document position at click time, so this path stays
		// correct even after edits shift the chip and never has the Reading-view
		// duplicate-reference ambiguity. `preventDefault`/`stopPropagation` keep
		// CodeMirror's own context menu from also opening.
		chip.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.plugin.showLiveChipMenu(evt, view, chip, this.ref);
		});
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
export function inlineChipEditorExtension(
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
