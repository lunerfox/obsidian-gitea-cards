import type GiteaCardsPlugin from "../main";
import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import { DEFAULT_ACCENT_COLOR, DEFAULT_SETTINGS, MIN_REFRESH_SECONDS, SECRET_KEYS } from "../types";
import { COMMENTS_MAX_PREVIEW, splitRepo } from "../parse";

/**
 * Autocomplete for the accent-colour "add repository" field (issue #29).
 * Suggests repo slugs the token can see — served through the plugin's cached
 * {@link GiteaCardsPlugin.loadRepoList} so keystrokes coalesce to one request —
 * filtered by what's typed and minus any repo that already has an accent.
 */
export class RepoInputSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly plugin: GiteaCardsPlugin,
		private readonly taken: () => Record<string, string>
	) {
		super(app, inputEl);
	}

	protected async getSuggestions(query: string): Promise<string[]> {
		const taken = this.taken();
		const needle = query.trim().toLowerCase();
		const repos = await this.plugin.loadRepoList();
		return repos
			.filter((repo) => !taken[repo])
			.filter((repo) => repo.toLowerCase().includes(needle));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}
}

export class GiteaCardsSettingTab extends PluginSettingTab {
	plugin: GiteaCardsPlugin;

	constructor(app: App, plugin: GiteaCardsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Gitea base URL")
			.setDesc(
				"Public, globally reachable URL. A local-network or remote address is a manual fallback. Card links are built from this URL."
			)
			.addText((text) =>
				text
					.setPlaceholder("https://gitea.example.com")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default repository")
			.setDesc(
				"Used by the new-issue flow and bare references, in owner/repo form."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.defaultRepo)
					.onChange(async (value) => {
						this.plugin.settings.defaultRepo = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Inline keyword")
			.setDesc(
				"Trigger word for the inline reference syntax, placed before owner/repo:#123."
			)
			.addText((text) =>
				text
					.setPlaceholder("GITEA")
					.setValue(this.plugin.settings.keyword)
					.onChange(async (value) => {
						this.plugin.settings.keyword =
							value.trim() || DEFAULT_SETTINGS.keyword;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("In-progress label")
			.setDesc(
				"Label name that marks an issue as in progress. An open issue carrying it shows an amber dot and badge on its inline chip. Leave empty to disable."
			)
			.addText((text) =>
				text
					.setPlaceholder("In-progress")
					.setValue(this.plugin.settings.inProgressLabel)
					.onChange(async (value) => {
						this.plugin.settings.inProgressLabel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Refresh interval")
			.setDesc(
				`How often visible cards refresh, in seconds. Floored at ${MIN_REFRESH_SECONDS} seconds.`
			)
			.addText((text) =>
				text
					.setPlaceholder("60")
					.setValue(String(this.plugin.settings.refreshIntervalSeconds))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.refreshIntervalSeconds =
							Number.isFinite(parsed)
								? Math.max(MIN_REFRESH_SECONDS, parsed)
								: DEFAULT_SETTINGS.refreshIntervalSeconds;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Description truncation length")
			.setDesc("Maximum characters of issue body shown on a card.")
			.addText((text) =>
				text
					.setPlaceholder("160")
					.setValue(String(this.plugin.settings.truncationLength))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.truncationLength =
							Number.isFinite(parsed) && parsed > 0
								? parsed
								: DEFAULT_SETTINGS.truncationLength;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Comment preview count")
			.setDesc(
				"Number of recent comments shown when a card's comment thread is expanded."
			)
			.addText((text) =>
				text
					.setPlaceholder("3")
					.setValue(String(this.plugin.settings.commentPreviewCount))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.commentPreviewCount =
							Number.isFinite(parsed) && parsed > 0
								? Math.min(parsed, COMMENTS_MAX_PREVIEW)
								: DEFAULT_SETTINGS.commentPreviewCount;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show images in comments")
			.setDesc(
				"Load images pasted into comments inline in expanded threads. Off by default — when off, comments stay text-only. Images are fetched with your token, so private and access-gated attachments load; click one to open it full size."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showCommentImages)
					.onChange(async (value) => {
						this.plugin.settings.showCommentImages = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show attachments")
			.setDesc(
				"Show an attachment strip — image thumbnails and file chips — under single issue cards. Off by default. When on, each single issue card makes one extra request for its attachments; list blocks are unaffected and stay one request per card. Click a thumbnail to open it full size."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showAttachments)
					.onChange(async (value) => {
						this.plugin.settings.showAttachments = value;
						await this.plugin.saveSettings();
					})
			);

		this.renderAccentSettings(containerEl);

		new Setting(containerEl).setName("Credentials").setHeading();

		this.addSecretSetting(
			containerEl,
			"Gitea API token",
			"Personal access token with write:issue and read:repository scope. Stored in plaintext in this vault's data.json.",
			SECRET_KEYS.pat
		);

		this.addSecretSetting(
			containerEl,
			"Cloudflare Access client ID",
			"Service-token client ID. Sent only when the base URL is a public host behind Cloudflare Access — ignored on LAN or Tailscale addresses.",
			SECRET_KEYS.cfClientId
		);

		this.addSecretSetting(
			containerEl,
			"Cloudflare Access client secret",
			"Service-token client secret. Shown only once at creation in Cloudflare Zero Trust.",
			SECRET_KEYS.cfClientSecret
		);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc(
				"Query the server with the settings above to confirm the base URL and token work."
			)
			.addButton((button) =>
				button.setButtonText("Test connection").onClick(async () => {
					button.setDisabled(true).setButtonText("Testing…");
					try {
						const message = await this.plugin.client.testConnection();
						new Notice(message);
					} catch (error) {
						const message =
							error instanceof Error
								? error.message
								: "Connection test failed.";
						new Notice(`Connection failed: ${message}`);
					} finally {
						button.setDisabled(false).setButtonText("Test connection");
					}
				})
			);
	}

	/**
	 * Render the per-project accent-colour section (issue #19): a heading, the
	 * list of configured repos, and an "add repository" row below it. The list
	 * lives in its own container so add/remove can re-render just the rows (via
	 * {@link renderAccentRows}) without re-running the whole settings tab.
	 */
	private renderAccentSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Repository accent colours").setHeading();

		const listEl = containerEl.createDiv();
		this.renderAccentRows(listEl);

		let pending = "";
		let input: TextComponent | null = null;
		new Setting(containerEl)
			.setName("Add repository")
			.setDesc("Assign an accent colour to a repository, in owner/repo form.")
			.addText((text) => {
				input = text;
				text.setPlaceholder("Owner/repo").onChange((value) => {
					pending = value.trim();
				});
				// Autocomplete repo slugs the token can see (issue #29), skipping
				// any repo that already has an accent. Selecting one fills the
				// field and primes the add button.
				const suggest = new RepoInputSuggest(
					this.app,
					text.inputEl,
					this.plugin,
					() => this.plugin.settings.repoAccents
				);
				suggest.onSelect((value) => {
					pending = value;
					text.setValue(value);
					suggest.close();
				});
			})
			.addButton((button) =>
				button.setButtonText("Add").onClick(async () => {
					if (!splitRepo(pending)) {
						new Notice("Enter a repository in owner/repo form.");
						return;
					}
					if (this.plugin.settings.repoAccents[pending]) {
						new Notice("That repository already has an accent colour.");
						return;
					}
					this.plugin.settings.repoAccents[pending] = DEFAULT_ACCENT_COLOR;
					await this.plugin.saveSettings();
					this.renderAccentRows(listEl);
					pending = "";
					input?.setValue("");
				})
			);
	}

	/**
	 * (Re)render one colour-picker row per configured repo into `listEl`,
	 * replacing whatever was there. Each row carries a remove button; editing a
	 * colour saves immediately, removing one re-renders the list in place.
	 */
	private renderAccentRows(listEl: HTMLElement): void {
		listEl.empty();
		const accents = this.plugin.settings.repoAccents;
		const repos = Object.keys(accents).sort();
		if (repos.length === 0) {
			new Setting(listEl).setDesc(
				"No accent colours set. Add a repository below to tint its cards with a subtle coloured left border."
			);
			return;
		}
		for (const repo of repos) {
			new Setting(listEl)
				.setName(repo)
				.addColorPicker((picker) =>
					picker.setValue(accents[repo]).onChange(async (value) => {
						this.plugin.settings.repoAccents[repo] = value;
						await this.plugin.saveSettings();
					})
				)
				.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip("Remove accent colour")
						.onClick(async () => {
							delete this.plugin.settings.repoAccents[repo];
							await this.plugin.saveSettings();
							this.renderAccentRows(listEl);
						})
				);
		}
	}

	/**
	 * Render a masked setting row backed by secretStorage. The field shows a
	 * placeholder when a secret is already stored and only writes on change, so
	 * the stored secret is never read back into the DOM.
	 */
	private addSecretSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		secretKey: string
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		setting.addText((text) => {
			text.inputEl.type = "password";
			text.setPlaceholder("Stored in data.json");
			void this.plugin.getSecret(secretKey).then((existing) => {
				if (existing) {
					text.setPlaceholder("•••••• (stored)");
				}
			});
			text.onChange(async (value) => {
				try {
					await this.plugin.setSecret(secretKey, value.trim());
				} catch (error) {
					// Surface any persistence failure instead of dropping the
					// secret silently.
					const message =
						error instanceof Error ? error.message : String(error);
					new Notice(`Could not save "${name}": ${message}`);
				}
			});
		});
	}
}
