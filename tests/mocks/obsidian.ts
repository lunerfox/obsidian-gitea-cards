/**
 * Minimal runtime stand-in for the real `obsidian` package, which ships types
 * only (`main: ""` in its package.json — there is no JS to load outside the
 * Obsidian app). `main.ts` imports several of these names as *values* (base
 * classes it `extends`, or functions/objects it references at module scope
 * indirectly through those classes), so importing `main.ts` under Vitest needs
 * something real to resolve "obsidian" to. This file is aliased in place of
 * "obsidian" by `vitest.config.ts` — it is never used for type-checking
 * (tsc/eslint still resolve "obsidian" to the real package), only so the
 * module graph can load without instantiating or calling any of this.
 *
 * None of these stubs need correct behaviour: the characterization tests only
 * exercise the pure query-parser functions, never the Plugin/Modal/etc. classes
 * that merely need to exist so `class Foo extends Bar` doesn't throw at load.
 */

export class AbstractInputSuggest {}
export class App {}
export class ButtonComponent {}
export class Component {}
export class Editor {}
export class EditorSuggest {}
export class ExtraButtonComponent {}
export class MarkdownRenderChild {}
export class MarkdownView {}
export class Menu {}
export class Modal {}
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class TextComponent {}
export class TFile {}

export const MarkdownRenderer = {
	render: async () => {},
};

export const requestUrl = async () => ({
	status: 0,
	headers: {},
	text: "",
	json: {},
	arrayBuffer: new ArrayBuffer(0),
});

export const editorLivePreviewField = {};
