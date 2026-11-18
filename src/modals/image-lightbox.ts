import type GiteaCardsPlugin from "../main";
import { Component, Modal } from "obsidian";

/**
 * The insert-existing-issue form. Pick a repo and one of its issues, then drop
 * the matching `gitea-issue` card into the editor at the cursor. Reuses the same
 * repo/issue lookups as the inline `GITEA:` autocomplete and the same card-block
 * builder as the new-issue flow, so it stays a thin UI over existing wiring.
 */
/**
 * Full-size, in-app lightbox for a comment image (issue #53, maintainer Q4 — an
 * in-app modal, not the system browser). Loads the same token-authed bytes as the
 * thumbnail through {@link GiteaCardsPlugin.loadAuthedImage}, owned by a private
 * {@link Component} so the object URL is revoked when the modal closes (a `Modal`
 * is not itself a `Component`, so it can't own the revocation directly).
 */
export class ImageLightboxModal extends Modal {
	private readonly owner = new Component();

	constructor(
		private readonly plugin: GiteaCardsPlugin,
		private readonly url: string,
		private readonly alt: string
	) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		this.owner.load();
		const { contentEl, modalEl } = this;
		modalEl.addClass("gitea-lightbox-modal");
		contentEl.empty();
		contentEl.addClass("gitea-lightbox");
		const status = contentEl.createDiv({
			cls: "gitea-lightbox__status",
			text: "Loading image…",
		});
		try {
			const objectUrl = await this.plugin.loadAuthedImage(
				this.url,
				this.owner
			);
			if (!contentEl.isConnected) {
				return;
			}
			status.remove();
			const img = contentEl.createEl("img", {
				cls: "gitea-lightbox__image",
			});
			img.setAttr("src", objectUrl);
			if (this.alt) {
				img.setAttr("alt", this.alt);
			}
		} catch (error: unknown) {
			if (!contentEl.isConnected) {
				return;
			}
			status.setText(
				error instanceof Error
					? error.message
					: "Image could not be loaded."
			);
		}
	}

	onClose(): void {
		// Revokes the object URL minted above (registered on the owner component).
		this.owner.unload();
		this.contentEl.empty();
	}
}
