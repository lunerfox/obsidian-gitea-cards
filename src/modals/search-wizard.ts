import type GiteaCardsPlugin from "../main";
import { Editor, Modal, Setting } from "obsidian";
import { GiteaLabel, GiteaMilestoneListItem } from "../types";
import { labelTextColor, splitRepo } from "../parse";
import { ALL_REPOS_LABEL, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SearchLayout, SearchQuery, buildSearchBlock, insertSearchBlock, splitList } from "../query";
import { addPicker } from "./picker";

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
export class SearchQueryWizardModal extends Modal {
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
	/** Assignee username to filter on ("" = any assignee, issue #62). */
	private assignee = "";
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
			.setName("Assignee")
			.setDesc("Filter to issues assigned to this username.")
			.addText((text) => {
				text.setPlaceholder("Optional").onChange((value) => {
					this.assignee = value;
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
			assignee: this.assignee.trim() || null,
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
			const repos = await this.plugin.client.fetchRepos();
			const options = [
				...new Set([this.repo, ...repos].filter((slug) => slug.length > 0)),
			];
			setting.setDesc(
				"Repository to search, or all repositories. Type to search."
			);
			addPicker(this.app, setting, {
				placeholder: "Search repositories…",
				options: () => [
					{ value: "", label: ALL_REPOS_LABEL },
					...options.map((slug) => ({ value: slug, label: slug })),
				],
				display: () => this.repo || ALL_REPOS_LABEL,
				onPick: (option) => {
					this.repo = option.value;
					void this.renderMetadata();
				},
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
				this.plugin.client.fetchLabels(this.repo),
				this.plugin.client.fetchMilestones(this.repo),
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
		const setting = new Setting(container).setName("Milestone");
		addPicker(this.app, setting, {
			placeholder: "Search milestones…",
			options: () => [
				{ value: "", label: "None" },
				...this.milestones.map((milestone) => ({
					value: milestone.title,
					label: milestone.title,
				})),
			],
			display: () => this.milestone || "None",
			onPick: (option) => {
				this.milestone = option.value;
				this.updatePreview();
			},
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
