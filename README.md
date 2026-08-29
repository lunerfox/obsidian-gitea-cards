# Gitea Cards

Render live, auto-refreshing [Gitea](https://about.gitea.com/) issue cards inline
in your [Obsidian](https://obsidian.md) notes, and create issues without leaving
the editor.

> **Status:** feature-complete and being prepared for the Obsidian community
> directory. Cards, search, milestone progress, the dependency graph, inline
> references, autocomplete, quick actions, paste-to-card, per-repo accents, and
> Cloudflare-access support have all shipped.

## What it does

- **Issue cards** — drop a `gitea-issue` code block with a single issue reference
  and get a compact card: number (linked), title, truncated body, label chips,
  comment count, state, author, milestone, and last-updated time — all from one
  Gitea API call.
- **Comment-thread preview** — click a card's comment count to expand the latest
  comments inline (rendered as Markdown, with author and relative time), so you can
  follow an issue's conversation without leaving the note. Comments are fetched
  lazily on first expand and refresh on the card's cadence. Add a `comments: 3`
  line under the reference to auto-expand the thread with a given count; the default
  count is configurable in settings. A card with a `comments:` line also renders its
  thread into an **Export to PDF** output (a card without one prints with no comments).
- **On-card quick actions** — a single-issue card carries an action bar to manage the
  issue without leaving the note: **Close** (or **Reopen**, for a closed issue) toggles
  its state, **Comment** opens an inline box to post a comment, and **Labels** opens a
  checkable menu to add or remove the repo's labels. These write actions appear only
  once a per-repo probe confirms your token can edit issues (and never on a stale,
  offline card, where they would only fail); a **Refresh** button is always offered.
- **Auto-refresh + offline cache** — visible cards refresh on a configurable
  interval (default 60s, floored at 30s); a shared cache coalesces duplicate
  fetches, and unreachable cards render stale rather than erroring.
- **Search & milestone blocks** — `gitea-search` lists issues by repo/state/
  labels/milestone/assignee, as a compact chip-like table by default (`layout:
  cards` for full cards); `gitea-milestone` renders a progress bar. A **Build search
  query** command opens a wizard that fills the block's fields from searchable
  pickers and label chips with a live preview, so you never have to memorise the
  syntax.
- **Dependency graph** — a `gitea-graph` block scopes a milestone (or any search
  filter) and renders its issues as a dependency DAG: one node per issue coloured
  by state, edges drawn blocker → dependent from native Gitea dependencies (and
  the `blocked-by:#N` label convention), with still-blocked issues dimmed so the
  currently-unblocked work — what the issue processor picks up next — stands out.
  Add `direction: LR` for a left-to-right layout; click a node to open it in Gitea.
  A **Build graph view** command opens a wizard that scopes the graph to a *set*
  of milestones (added from a searchable picker, listed as removable chips), with the same
  repo/labels/state/limit/direction controls and live preview, so you never have
  to memorise the syntax.
- **Create issues** — a command and modal to file issues (and convert a selection
  into a tracked issue) without opening the browser. Choose, per insert, whether
  the new (or existing) issue lands as a full card, a compact inline status chip,
  or nothing at all — the choice is remembered for next time. A search block's
  **Add issue** button defaults to inserting nothing, since the new issue shows up
  in that table on the next refresh.
- **Keyboard-searchable pickers** — every repository, issue, and milestone picker in
  the modals is a search field, not a mouse-only dropdown: focus it to drop the full
  list open, type to filter (an issue matches on its number *or* its title), and use
  up/down + Enter to choose.
- **Paste to card** — paste a Gitea issue URL (`…/owner/repo/issues/123`) into the
  editor and it is replaced in place with a live `gitea-issue` card. Only links on
  your configured base host are converted; other text and links paste untouched.
- **Inline references** — type `GITEA:owner/repo:#123` with autocomplete at each
  colon; on completion it is wrapped in backticks (`` `GITEA:owner/repo:#123` ``)
  and the backtick-wrapped reference renders as a lightweight chip showing the
  issue title and open/closed status. A bare, un-backticked reference in prose is
  left as plain text.
- **Right-click to switch presentation** — right-click a rendered card and choose
  **Convert to inline chip**, or right-click a chip and choose **Convert to card**,
  to flip an already-placed reference between the two formats in place — no
  hand-editing of the Markdown. Works in Reading view and Live Preview. Converting
  a chip that sits mid-sentence splits the line so the fenced card lands on its own
  line and the surrounding prose is kept.
- **Global access** — works off-LAN through Cloudflare Access using a service
  token, alongside a Gitea personal access token.

## Architecture

The plugin is a single TypeScript source, `main.ts`, bundled to `main.js` by
esbuild. There is no runtime framework beyond the Obsidian API; the design is
deliberately small so it stays inside the constraints of Obsidian's automated
community review (mobile-safe, no Node/Electron APIs, DOM built with `createEl`).

**Entry point — `GiteaCardsPlugin extends Plugin`.** `onload()` wires everything
and relies on Obsidian's component registration (`registerInterval`,
`registerEvent`, `registerDomEvent`, `addCommand`, `registerMarkdownCodeBlockProcessor`,
`registerEditorExtension`, `registerMarkdownPostProcessor`) so every timer,
listener, and view tears down automatically on unload.

**Rendered blocks.** Four fenced code-block languages each map to a
`MarkdownRenderChild` subclass that owns its own auto-refresh interval, tied to the
rendered element's lifecycle:

| Block | Render child | Renders |
| --- | --- | --- |
| `gitea-issue` | `IssueCardChild` | one issue card from a single `owner/repo#index` reference |
| `gitea-search` | `SearchBlockChild` | a chip-like table (or list of cards) from a repo/state/label/milestone/assignee query |
| `gitea-milestone` | `MilestoneBlockChild` | a progress bar from a milestone's open/closed counts |
| `gitea-graph` | `GraphBlockChild` | a dependency DAG (SVG) of a milestone's/query's issues, coloured by state with blocker → dependent edges |

**Inline references.** A backtick-wrapped `` `GITEA:owner/repo:#123` `` renders as a
lightweight chip through two paths: a CodeMirror 6 editor extension
(`inlineChipEditorExtension` + `InlineChipWidget`) for Live Preview, and a
`registerMarkdownPostProcessor` (`InlineChipChild`) for Reading view. Typing the
reference is assisted by `GiteaInlineSuggest extends EditorSuggest`, which offers
autocomplete at each colon. Both render paths refresh on the same interval as cards.

**Issue creation & insertion.** `NewIssueModal` and `InsertIssueModal` (plus the
matching commands and the paste handler that rewrites pasted Gitea URLs) drive the
write/insert flows. `SearchQueryWizardModal` builds `gitea-search` blocks from a
form with a live preview (serialised by `buildSearchBlock`, the inverse of
`parseSearchQuery`). Repository fields use `RepoInputSuggest extends
AbstractInputSuggest` for slug autocomplete.

**Network layer.** Every Gitea call goes through Obsidian's `requestUrl()` — never
`fetch` — so it works on mobile and bypasses Electron's CORS handling. Requests are
built from the configured base URL (`{base}/api/v1/...`); card and issue links are
built from the same base + `/{owner}/{repo}/issues/{index}`, ignoring the API's
`html_url` (Gitea's `ROOT_URL` is still the LAN IP). `buildAuthHeaders()` attaches
`Authorization: token <PAT>` and, when the base URL is a Cloudflare host, the
`CF-Access-Client-Id` / `CF-Access-Client-Secret` service-token pair. List endpoints
pass `type=issues` (and drop any `pull_request` item) so PRs never leak into results.

**Caching & rate control.** Gitea has no ETag and no rate limiter, so a shared
`CoalescingCache` / `IssueCache`, keyed by `owner/repo#index`, coalesces duplicate
in-flight fetches and serves a freshness window. Refresh intervals are floored at
`MIN_REFRESH_SECONDS` (30 s); transient failures back off exponentially up to
`MAX_BACKOFF_MS` (30 min), and unreachable cards render stale rather than erroring.

**Settings & secrets.** `GiteaCardsSettingTab` renders configuration; the Gitea PAT
and Cloudflare Access credentials live in `app.secretStorage` (the OS keychain),
never in `data.json`.

## Installation (development)

This plugin is not yet in the community directory. To build it locally:

```bash
npm install
npm run build      # emits main.js
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault under
`.obsidian/plugins/gitea-cards/` and enable the plugin in **Settings → Community
plugins**.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Gitea base URL | — | Your Gitea instance, e.g. `https://gitea.example.com`. Card links are built from this URL; a local-network or remote address is a manual fallback. |
| Default repository | — | `owner/repo` used by the new-issue flow and bare references. |
| Inline keyword | `GITEA` | Trigger for the inline reference syntax. |
| In-progress label | — | Open issues carrying this label show an amber dot and "in progress" badge on their inline chip. Empty disables it. |
| Refresh interval | `60` s | Floored at 30 s. |
| Description truncation length | `160` | Max characters of body shown on a card. |
| Comment preview count | `3` | Recent comments shown when a card's thread is expanded; a `comments: N` block key overrides it per card. |
| Gitea API token | — | `write:issue` + `read:repository`; stored in the OS keychain. |
| Cloudflare Access client ID / secret | — | Service-token credentials; stored in the OS keychain. |

Tokens are stored via Obsidian's secret storage (OS keychain), never in
`data.json`.

## Development

- `npm run dev` — esbuild watch build.
- `npm run build` — type-check + production build.
- `npm run lint` — `eslint-plugin-obsidianmd` (the official community-review lint).
- `npm version patch|minor|major` — bumps `manifest.json` + `versions.json` in
  lockstep via `version-bump.mjs`.

CI (`.gitea/workflows/ci.yml`) lints and builds on every push; the GitHub mirror
cuts draft releases via `.github/workflows/release.yml`.

## License

[MIT](LICENSE)
