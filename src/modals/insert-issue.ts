import type GiteaCardsPlugin from "../main";
import { ButtonComponent, Editor, Modal, Notice, Setting } from "obsidian";
import { InlineIssueSummary, IssueInsertFormat, IssueRef } from "../types";
import { insertIssueReference, splitRepo } from "../parse";
import { addPicker } from "./picker";

export class InsertIssueModal extends Modal {
	private repo: string;
	private issues: InlineIssueSummary[] = [];
	private selectedIndex: number | null = null;
	private insertFormat: IssueInsertFormat;

	private repoSetting: Setting | null = null;
	private issueEl: HTMLElement | null = null;
	private insertButton: ButtonComponent | null = null;

	constructor(
		private readonly plugin: GiteaCardsPlugin,
		private readonly editor: Editor
	) {
		super(plugin.app);
		this.repo = plugin.settings.defaultRepo;
		// "None" is only meaningful when creating an issue (issue #37); inserting an
		// *existing* issue as nothing is pointless, so fall back to a card here.
		this.insertFormat =
			plugin.settings.insertFormat === "none"
				? "card"
				: plugin.settings.insertFormat;
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("Insert existing issue");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gitea-insert-issue");

		// Repo picker — populated asynchronously below.
		this.repoSetting = new Setting(contentEl).setName("Repository");

		// Issue picker — rebuilt whenever the repo changes.
		this.issueEl = contentEl.createDiv();

		// Card vs. compact inline status, mirroring the new-issue modal (issue #21).
		new Setting(contentEl)
			.setName("Insert as")
			.setDesc("Drop a full card or a compact inline status into the note.")
			.addDropdown((dropdown) => {
				dropdown.addOption("card", "Card");
				dropdown.addOption("inline", "Inline status");
				dropdown.setValue(this.insertFormat);
				dropdown.onChange((value) => {
					this.insertFormat = value as IssueInsertFormat;
					// Remember the choice so it sticks for the next insert.
					this.plugin.settings.insertFormat = this.insertFormat;
					void this.plugin.saveSettings();
				});
			});

		new Setting(contentEl).addButton((button) => {
			this.insertButton = button;
			button
				.setButtonText("Insert")
				.setCta()
				.onClick(() => this.submit());
		});

		await this.renderRepoControl();
		await this.renderIssues();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * Fill the repo picker. Offers a dropdown of repos the token can see (with the
	 * default always selectable); if the list can't be fetched, falls back to a
	 * free-text field plus a reload button so the issue list can still be pulled.
	 * Mirrors {@link NewIssueModal}'s repo control.
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
			setting.setDesc("Repository to insert an issue from. Type to search.");
			addPicker(this.app, setting, {
				placeholder: "Search repositories…",
				options: () =>
					options.map((slug) => ({ value: slug, label: slug })),
				display: () => this.repo,
				onPick: (option) => {
					this.repo = option.value;
					void this.renderIssues();
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
					.setTooltip("Load issues")
					.onClick(() => void this.renderIssues());
			});
		}
	}

	/**
	 * Rebuild the issue dropdown for the current repo. Fetches the repo's issues
	 * (PRs already excluded by {@link GiteaCardsPlugin.fetchInlineIssues}), guards
	 * against a repo change that lands while the request is in flight, and shows a
	 * one-line notice for an empty list or a failed lookup.
	 */
	private async renderIssues(): Promise<void> {
		const container = this.issueEl;
		if (!container) {
			return;
		}
		this.selectedIndex = null;
		this.issues = [];
		container.empty();

		const parsed = splitRepo(this.repo);
		if (!parsed) {
			container.createDiv({
				cls: "gitea-insert-issue__notice",
				text: "Enter a repository in owner/repo form.",
			});
			return;
		}

		const repoAtFetch = this.repo;
		container.createDiv({
			cls: "gitea-insert-issue__notice",
			text: "Loading issues…",
		});
		let issues: InlineIssueSummary[];
		try {
			issues = await this.plugin.client.fetchInlineIssues(this.repo);
		} catch (error) {
			if (this.repo !== repoAtFetch) {
				return; // A newer render superseded this one.
			}
			container.empty();
			container.createDiv({
				cls: "gitea-insert-issue__notice",
				text:
					error instanceof Error
						? error.message
						: "Could not load issues.",
			});
			return;
		}
		if (this.repo !== repoAtFetch) {
			return; // A newer render superseded this one.
		}

		this.issues = issues;
		container.empty();

		if (issues.length === 0) {
			container.createDiv({
				cls: "gitea-insert-issue__notice",
				text: "This repository has no issues.",
			});
			return;
		}

		this.selectedIndex = issues[0].index;
		const setting = new Setting(container)
			.setName("Issue")
			.setDesc("Type a number or part of the title to search.");
		addPicker(this.app, setting, {
			placeholder: "Search issues…",
			options: () =>
				issues.map((issue) => ({
					value: String(issue.index),
					label: `#${issue.index} — ${issue.title}`,
					note: issue.state === "closed" ? "closed" : undefined,
				})),
			display: () => this.issueLabel(this.selectedIndex),
			onPick: (option) => {
				this.selectedIndex = Number.parseInt(option.value, 10);
			},
		});
	}

	/** The picker's text for a selected issue index — `#12 — Title`, or blank. */
	private issueLabel(index: number | null): string {
		const issue = this.issues.find((candidate) => candidate.index === index);
		return issue ? `#${issue.index} — ${issue.title}` : "";
	}

	/**
	 * Insert the picked issue in the chosen format — a `gitea-issue` card or a
	 * compact inline status chip — at the cursor (or over any selection), then
	 * close. Validates the repo and that an issue is selected first.
	 */
	private submit(): void {
		const parsed = splitRepo(this.repo);
		if (!parsed) {
			new Notice("Enter a repository in owner/repo form.");
			return;
		}
		if (this.selectedIndex === null) {
			new Notice("Choose an issue to insert.");
			return;
		}
		const ref: IssueRef = {
			owner: parsed.owner,
			repo: parsed.repo,
			index: this.selectedIndex,
		};
		insertIssueReference(
			this.editor,
			ref,
			this.insertFormat,
			this.plugin.settings.keyword
		);
		this.close();
	}
}
