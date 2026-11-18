import type GiteaCardsPlugin from "../main";
import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from "obsidian";
import { InlineSuggestion } from "../types";
import { escapeRegExp, splitRepo } from "../parse";

/**
 * Inline single-issue autocomplete (F6). A multi-stage {@link EditorSuggest}:
 * typing the editable keyword + `:` suggests repos, and after `owner/repo:` it
 * suggests that repo's issues. `onTrigger` runs on every keystroke, so it bails
 * cheaply (a substring check, no lookbehind regex) on anything non-matching.
 */
export class GiteaInlineSuggest extends EditorSuggest<InlineSuggestion> {
	/** Which stage the latest trigger landed in — set by `onTrigger`. */
	private stage: "repo" | "issue" = "repo";
	/** The `owner/repo` resolved for an issue-stage trigger. */
	private repoSlug = "";
	/**
	 * Column of the keyword's first character on the trigger line, recorded on an
	 * issue-stage trigger so {@link selectSuggestion} can wrap the *whole*
	 * reference (`GITEA:owner/repo:#123`) in backticks on completion — the chip
	 * only renders from a backtick-wrapped reference (issue #14).
	 */
	private referenceStart = 0;

	constructor(private readonly plugin: GiteaCardsPlugin) {
		super(plugin.app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_file: TFile | null
	): EditorSuggestTriggerInfo | null {
		const keyword = this.plugin.settings.keyword;
		if (!keyword) {
			return null;
		}
		const beforeCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
		// Cheap mandatory early-out: the vast majority of keystrokes never type
		// the keyword, so skip the regex entirely unless the marker is present.
		if (!beforeCursor.includes(`${keyword}:`)) {
			return null;
		}
		// `[^\s:]*` keeps a segment to a single token; the optional second group
		// distinguishes the repo stage (no second colon) from the issue stage.
		const pattern = new RegExp(
			`${escapeRegExp(keyword)}:([^\\s:]*)(?::([^\\s:]*))?$`
		);
		const match = pattern.exec(beforeCursor);
		if (!match) {
			return null;
		}
		const repoSegment = match[1];
		const issueSegment = match[2];

		if (issueSegment === undefined) {
			// Stage 1 — `GITEA:` plus a partial repo slug.
			this.stage = "repo";
			this.repoSlug = "";
			return {
				start: { line: cursor.line, ch: cursor.ch - repoSegment.length },
				end: cursor,
				query: repoSegment,
			};
		}

		// Stage 2 — `GITEA:owner/repo:` plus a partial issue. Needs a valid slug.
		const parsed = splitRepo(repoSegment);
		if (!parsed) {
			return null;
		}
		this.stage = "issue";
		this.repoSlug = `${parsed.owner}/${parsed.repo}`;
		// `match.index` is the keyword's column on the line (the pattern is anchored
		// at the cursor, not the start) — where the backtick wrapping begins.
		this.referenceStart = match.index;
		return {
			start: { line: cursor.line, ch: cursor.ch - issueSegment.length },
			end: cursor,
			query: issueSegment,
		};
	}

	async getSuggestions(
		context: EditorSuggestContext
	): Promise<InlineSuggestion[]> {
		const query = context.query.toLowerCase();
		try {
			if (this.stage === "repo") {
				const repos = await this.plugin.loadRepoList();
				return repos
					.filter((repo) => repo.toLowerCase().includes(query))
					.slice(0, 20)
					.map((repo) => ({ kind: "repo", repo }));
			}
			const needle = query.replace(/^#/, "");
			const issues = await this.plugin.loadInlineIssues(this.repoSlug);
			return issues
				.filter(
					(issue) =>
						String(issue.index).includes(needle) ||
						issue.title.toLowerCase().includes(needle)
				)
				.slice(0, 20)
				.map((issue) => ({
					kind: "issue",
					index: issue.index,
					title: issue.title,
					state: issue.state,
				}));
		} catch {
			return []; // A failed lookup just closes the popup.
		}
	}

	renderSuggestion(value: InlineSuggestion, el: HTMLElement): void {
		el.addClass("gitea-suggestion");
		if (value.kind === "repo") {
			el.createSpan({ cls: "gitea-suggestion__repo", text: value.repo });
			return;
		}
		el.createSpan({
			cls: "gitea-suggestion__number",
			text: `#${value.index}`,
		});
		el.createSpan({
			cls: "gitea-suggestion__title",
			text: `— ${value.title}`,
		});
	}

	selectSuggestion(value: InlineSuggestion): void {
		const ctx = this.context;
		if (!ctx) {
			return;
		}
		if (value.kind === "repo") {
			// Picking a repo leaves a trailing colon so the next keystroke-free
			// re-trigger advances to the issue stage.
			const insert = `${value.repo}:`;
			ctx.editor.replaceRange(insert, ctx.start, ctx.end);
			ctx.editor.setCursor({
				line: ctx.start.line,
				ch: ctx.start.ch + insert.length,
			});
			return;
		}
		// Picking an issue completes the reference and wraps the whole thing in
		// backticks, since the chip only renders from a backtick-wrapped
		// (inline-code) reference — a bare reference in prose is left alone (issue
		// #14). Absorb any backticks the user already typed around the reference so
		// we never end up doubling them.
		const line = ctx.editor.getLine(ctx.start.line);
		let startCh = this.referenceStart;
		if (startCh > 0 && line.charAt(startCh - 1) === "`") {
			startCh -= 1;
		}
		let endCh = ctx.end.ch;
		if (line.charAt(endCh) === "`") {
			endCh += 1;
		}
		const insert = `\`${this.plugin.settings.keyword}:${this.repoSlug}:#${value.index}\``;
		ctx.editor.replaceRange(
			insert,
			{ line: ctx.start.line, ch: startCh },
			{ line: ctx.end.line, ch: endCh }
		);
		ctx.editor.setCursor({
			line: ctx.start.line,
			ch: startCh + insert.length,
		});
	}
}
