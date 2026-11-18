import type GiteaCardsPlugin from "../main";
import { Editor, Modal, Setting } from "obsidian";
import { GiteaLabel, GiteaMilestoneListItem } from "../types";
import { labelTextColor, splitRepo } from "../parse";
import { ALL_REPOS_LABEL, GraphDirection, GraphQuery, SEARCH_MAX_LIMIT, buildGraphBlock, insertGraphBlock, splitList } from "../query";
import { addPicker } from "./picker";

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
export class GraphQueryWizardModal extends Modal {
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
			const repos = await this.plugin.client.fetchRepos();
			const options = [
				...new Set([this.repo, ...repos].filter((slug) => slug.length > 0)),
			];
			setting.setDesc(
				"Repository to graph, or all repositories. Type to search."
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
				this.plugin.client.fetchLabels(this.repo),
				this.plugin.client.fetchMilestones(this.repo),
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
	private renderMilestoneControls(section: HTMLElement, focus = false): void {
		section.empty();
		const remaining = this.milestones.filter(
			(milestone) => !this.selectedMilestones.has(milestone.title)
		);
		const setting = new Setting(section)
			.setName("Add milestone")
			.setDesc("Type to search. A graph can span several milestones.");
		addPicker(this.app, setting, {
			placeholder:
				remaining.length > 0
					? "Search milestones…"
					: "All milestones added",
			disabled: remaining.length === 0,
			options: () =>
				remaining.map((milestone) => ({
					value: milestone.title,
					label: milestone.title,
				})),
			// The field stays empty: a pick moves into the chip set below, not here.
			display: () => "",
			onPick: (option) => {
				this.selectedMilestones.add(option.value);
				// Rebuilds this section — including the picker, whose option list must
				// drop what was just added — so put focus back for a run of adds.
				this.renderMilestoneControls(section, true);
				this.updatePreview();
			},
		});
		if (focus) {
			section
				.querySelector<HTMLInputElement>("input.gitea-picker")
				?.focus();
		}

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
