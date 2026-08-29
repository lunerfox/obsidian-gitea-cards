# Gitea Cards — Obsidian Plugin Instructions

> Maintainer-specific automation — exact vault paths, the self-hosted Gitea URL,
> the issue-processor model flags, the NAS deploy ritual, and the `alpine/git`
> commit wrapper — lives in `CLAUDE.local.md`, which is gitignored and not part of
> the public repo. Everything below is the general, public-safe guidance.

Release, versioning, and community-review procedure live in the
`obsidian-plugin-publish` skill. Only facts true of *this* repo live here.

## What this plugin is

`gitea-cards` renders live, auto-refreshing Gitea issue cards inline in Obsidian notes and lets you create issues without leaving the editor. It is built from day one to pass Obsidian's **per-version automated community review**. The whole feature set rests on a single Gitea REST call per card, so everything ships as v1 under one milestone (`Obsidian Gitea Cards`).

## Repo facts

- **`manifest.json` identity:** `id` is `gitea-cards`; `name` is `Gitea Cards`.
- **Public home:** the plugin is published to `github.com/lunerfox/obsidian-gitea-cards`
  for the Obsidian community directory.
- **Secrets:** the Gitea PAT and the Cloudflare Access client ID/secret live in
  `app.secretStorage`, never in `data.json`.

## Gitea / Cloudflare specifics

- Build issue/card links from the **configured base URL** + `/{owner}/{repo}/issues/{index}` — ignore the API's `html_url` host (a self-hosted Gitea's `ROOT_URL` is often a LAN address).
- Gitea has **no ETag and no rate limiter** — coalesce duplicate fetches, share one cache keyed by `owner/repo#index`, and floor the refresh interval (≥ 30s, see `MIN_REFRESH_SECONDS`).
- List endpoints (`/issues`, `/repos/issues/search`) return **PRs too** — pass `type=issues` or drop items where `pull_request != null`.
- Create takes label/milestone **IDs**; list filters take **names** — map in the plugin.
- Cloudflare path sends `CF-Access-Client-Id` + `CF-Access-Client-Secret` + `Authorization: token <PAT>`. A `302 → *.cloudflareaccess.com` is an edge reject (do **not** auto-follow); a `401/403` with a Gitea JSON body is a Gitea auth failure. The Access policy action must be **Service Auth**, not Allow.

## Layout

`main.ts` → `main.js` (esbuild), `styles.css`, `manifest.json`, `versions.json`, `version-bump.mjs`. CI lints + builds on a self-hosted runner via `.gitea/workflows/ci.yml`; the GitHub mirror cuts releases via `.github/workflows/release.yml`.
