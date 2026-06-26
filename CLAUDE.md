# Gitea Cards — Obsidian Plugin Instructions

> Maintainer-specific automation — exact vault paths, the self-hosted Gitea URL,
> the issue-processor model flags, the NAS deploy ritual, and the `alpine/git`
> commit wrapper — lives in `CLAUDE.local.md`, which is gitignored and not part of
> the public repo. Everything below is the general, public-safe guidance.

## CRITICAL: Planning vs Implementation

> **WARNING: Do NOT begin implementation when asked to "plan", "design", "think through", or "figure out" something.**

When a request contains words like **plan**, **proposal**, **design**, **approach**, **strategy**, **think about**, **figure out**, **brainstorm**, or **consider**, this is a **planning request only**. It means:

- **STOP** — do not edit any files
- **STOP** — do not create any files
- **STOP** — do not run any commands that modify state
- **STOP** — do not start any services or containers
- **DO** — write the plan down and present it
- **DO** — ask for confirmation before doing anything else

**A plan is only a plan. It is NOT permission to implement.** Implementation only begins when the user explicitly approves the plan and instructs you to proceed.

If you are unsure whether a request is asking for a plan or asking for implementation, **default to planning only and ask the user to confirm** before touching any files.

---

## Git

This project is push-mirrored to the public `github.com/lunerfox/obsidian-gitea-cards` for the Obsidian community directory.

**After making changes, commit and push using ONLY the files you changed — never `git add .`.**

**Rules:**
- Never commit `.env` or `data.json` — both hold secrets.
- Never commit `CLAUDE.local.md` — it holds maintainer-specific paths and automation (it is gitignored).
- `main.js` is a build artifact — it is gitignored and attached to releases, not committed as source.
- Always push after committing so the mirror stays in sync.
- Only stage files relevant to the task — one focused commit per unit of work.

---

## Versioning

**Every change that ships gets a minor version bump.** Do not bump patch versions — this project advances the **minor** version for each functional change, fix, or content update so each release is easy to track in the Obsidian community directory and in `versions.json`.

```bash
npm version minor
```

`npm version minor` runs `version-bump.mjs`, which keeps `manifest.json` and `versions.json` in lockstep (and creates the matching git tag). Run it as part of the same unit of work whenever you make a change worth releasing.

**Rules:**
- Use `npm version minor` (not `patch`) for routine changes.
- Reserve `npm version major` for breaking changes only (e.g. dropping config compatibility or changing the plugin `id`).
- Confirm `manifest.json` `version` and the top key of `versions.json` match the new minor version before tagging a release.

---

## What this plugin is

`gitea-cards` renders live, auto-refreshing Gitea issue cards inline in Obsidian notes and lets you create issues without leaving the editor. It is built from day one to pass Obsidian's **per-version automated community review**. The whole feature set rests on a single Gitea REST call per card, so everything ships as v1 under one milestone (`Obsidian Gitea Cards`).

### Hard rules for community review (do not regress)

- **`manifest.json`**: `id` is `gitea-cards` (lowercase, no `obsidian`, not ending in `plugin`); `name` is `Gitea Cards`; `version` is strict semver matching the release tag (no `v` prefix) and the top key of `versions.json`; `isDesktopOnly: false`.
- **No Node/Electron APIs** — the plugin must run on mobile. Use `requestUrl()` from `obsidian` for every network call (Electron blocks plain `fetch` with CORS). No lookbehind in regexes.
- **Build DOM** with `createEl`/`createDiv`/`createSpan`; never `innerHTML`. Clear with `el.empty()`.
- **Sentence case** for all UI text; use `setHeading()` for section headings; no hardcoded inline styles — use CSS classes + Obsidian CSS variables in `styles.css`.
- **Secrets** (Gitea PAT, Cloudflare Access client ID/secret) live in `app.secretStorage` (OS keychain), never in `data.json`.
- Register everything that needs teardown (`registerInterval`, `registerEvent`, `registerDomEvent`, `addCommand`) so it auto-cleans on unload.
- Keep `eslint-plugin-obsidianmd` clean (`npm run lint`) and `manifest`/`versions` in lockstep on **every** release. `npm version patch|minor|major` runs `version-bump.mjs` to keep them aligned.

### Gitea / Cloudflare specifics

- Build issue/card links from the **configured base URL** + `/{owner}/{repo}/issues/{index}` — ignore the API's `html_url` host (a self-hosted Gitea's `ROOT_URL` is often a LAN address).
- Gitea has **no ETag and no rate limiter** — coalesce duplicate fetches, share one cache keyed by `owner/repo#index`, and floor the refresh interval (≥ 30s, see `MIN_REFRESH_SECONDS`).
- List endpoints (`/issues`, `/repos/issues/search`) return **PRs too** — pass `type=issues` or drop items where `pull_request != null`.
- Create takes label/milestone **IDs**; list filters take **names** — map in the plugin.
- Cloudflare path sends `CF-Access-Client-Id` + `CF-Access-Client-Secret` + `Authorization: token <PAT>`. A `302 → *.cloudflareaccess.com` is an edge reject (do **not** auto-follow); a `401/403` with a Gitea JSON body is a Gitea auth failure. The Access policy action must be **Service Auth**, not Allow.

### Layout

`main.ts` → `main.js` (esbuild), `styles.css`, `manifest.json`, `versions.json`, `version-bump.mjs`. CI lints + builds on a self-hosted runner via `.gitea/workflows/ci.yml`; the GitHub mirror cuts releases via `.github/workflows/release.yml`.

## Validation

Before declaring a ticket complete, run `npm install && npm run lint && npm run build` (or let CI do it) and confirm `npx eslint .` is clean and `main.js` builds. Report what was checked.
