import { AbstractInputSuggest, App, Setting } from "obsidian";

/** One entry in a searchable {@link addPicker} field (issue #64). */
export interface PickerOption {
	/** Value handed to the picker's `onPick`. */
	value: string;
	/** Text shown in the field, and the primary thing typing is matched against. */
	label: string;
	/** Muted trailing detail — searched too, so `closed` or a slug narrows the list. */
	note?: string;
}

/**
 * Filter picker options by what's typed: every whitespace-separated token has to
 * appear somewhere in the option's label or note, case-insensitively, with a
 * leading `#` stripped so `#12` finds issue 12. Matches are ranked by where the
 * first token lands, so a prefix hit sorts above a mid-string one.
 */
export function filterPickerOptions(
	options: PickerOption[],
	query: string
): PickerOption[] {
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.replace(/^#/, ""))
		.filter((token) => token.length > 0);
	if (tokens.length === 0) {
		return options;
	}
	return options
		.map((option) => ({
			option,
			haystack: `${option.label} ${option.note ?? ""}`.toLowerCase(),
		}))
		.filter((entry) =>
			tokens.every((token) => entry.haystack.includes(token))
		)
		.sort((a, b) => a.haystack.indexOf(tokens[0]) - b.haystack.indexOf(tokens[0]))
		.map((entry) => entry.option);
}

/**
 * Backs {@link addPicker}. Typing in the field is a *query*, never a value: the
 * field's text is always whatever the current selection reports, and a pick is
 * only ever made by choosing a suggestion (Enter or click).
 */
export class PickerSuggest extends AbstractInputSuggest<PickerOption> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly options: () => PickerOption[],
		private readonly onPick: (option: PickerOption) => void
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): PickerOption[] {
		return filterPickerOptions(this.options(), query);
	}

	renderSuggestion(option: PickerOption, el: HTMLElement): void {
		el.addClass("gitea-picker-suggestion");
		el.createSpan({ text: option.label });
		if (option.note) {
			el.createSpan({
				cls: "gitea-picker-suggestion__note",
				text: option.note,
			});
		}
	}

	selectSuggestion(option: PickerOption): void {
		this.close();
		this.onPick(option);
	}
}

/**
 * Add a keyboard-searchable picker to a {@link Setting} — the replacement for the
 * mouse-only `<select>` dropdowns the repo/issue/milestone controls used to be
 * (issue #64). Focusing the field drops the whole list open (so it still behaves
 * like a dropdown to a mouse), typing filters it, and up/down + Enter commit a
 * choice, which is all inherited from {@link AbstractInputSuggest}.
 *
 * `display` is a *getter*, not a captured string, so restoring the field's text
 * after a blur can never clobber a pick that landed in the same tick.
 */
export function addPicker(
	app: App,
	setting: Setting,
	config: {
		options: () => PickerOption[];
		display: () => string;
		onPick: (option: PickerOption) => void;
		placeholder?: string;
		disabled?: boolean;
	}
): void {
	setting.addText((text) => {
		const input = text.inputEl;
		input.addClass("gitea-picker");
		input.placeholder = config.placeholder ?? "Type to search…";
		input.value = config.display();
		input.disabled = config.disabled ?? false;
		// Clearing the field is what drops the *whole* list open: the suggester
		// re-queries on every `input` event, and an empty query matches everything.
		const openFullList = () => {
			input.value = "";
			input.dispatchEvent(new Event("input"));
		};
		new PickerSuggest(app, input, config.options, (option) => {
			config.onPick(option);
			input.value = config.display();
			// A pick leaves focus in the field, so pre-select the text it just put
			// there — otherwise the next keystroke would append to the label and
			// search for a string no option can match.
			input.select();
		});
		input.addEventListener("focus", openFullList);
		// Focus alone can't cover reopening after a pick (the field never lost it),
		// so a click on a field that's showing its selection reopens the list too —
		// while leaving a half-typed query alone.
		input.addEventListener("click", () => {
			if (input.value === config.display()) {
				openFullList();
			}
		});
		// Put the selection's label back once focus has really left. Deferred because
		// clicking a suggestion blurs the field *before* the pick is delivered.
		input.addEventListener("blur", () => {
			window.setTimeout(() => {
				if (input.ownerDocument.activeElement !== input) {
					input.value = config.display();
				}
			}, 0);
		});
	});
}
