import type GiteaCardsPlugin from "../main";
import { ButtonComponent, Editor, Modal, Notice, Setting } from "obsidian";
import { CreateIssuePayload, GiteaIssue, GiteaLabel, GiteaMilestoneListItem, IssueInsertFormat, IssueRef } from "../types";
import { attachmentMarkdown, defaultImageName, insertIssueReference, labelTextColor, splitRepo } from "../parse";
import { splitList } from "../query";
import { addPicker } from "./picker";

/** Options seeding a {@link NewIssueModal}. */
export interface NewIssueModalOptions {
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
export class NewIssueModal extends Modal {
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
			const repos = await this.plugin.client.fetchRepos();
			const options = [
				...new Set([this.repo, ...repos].filter((slug) => slug.length > 0)),
			];
			if (!this.repo && options.length > 0) {
				this.repo = options[0];
			}
			setting.setDesc("Repository to create the issue in. Type to search.");
			addPicker(this.app, setting, {
				placeholder: "Search repositories…",
				options: () =>
					options.map((slug) => ({ value: slug, label: slug })),
				display: () => this.repo,
				onPick: (option) => {
					this.repo = option.value;
					void this.renderMetadata();
					void this.renderAttachSection();
				},
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
				this.plugin.client.fetchLabels(this.repo),
				this.plugin.client.fetchMilestones(this.repo),
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
		const setting = new Setting(container).setName("Milestone");
		addPicker(this.app, setting, {
			placeholder: "Search milestones…",
			options: () => [
				{ value: "", label: "None" },
				...this.milestones.map((milestone) => ({
					value: String(milestone.id),
					label: milestone.title,
				})),
			],
			// Reflects a milestone carried over from the originating search (issue #35).
			display: () =>
				this.milestones.find((m) => m.id === this.milestoneId)?.title ??
				"None",
			onPick: (option) => {
				this.milestoneId = option.value
					? Number.parseInt(option.value, 10)
					: null;
			},
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
			issue = await this.plugin.client.createIssue(this.repo, payload);
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
				const attachment = await this.plugin.client.uploadIssueAsset(
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
				await this.plugin.client.editIssueBody(ref, newBody);
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
