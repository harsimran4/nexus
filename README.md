# Nexus

A zero-backend content manager for small content teams. One Google Drive folder is the entire database: media lives in per-project folders, and a single `nexus.json` carries all metadata (projects, items, statuses, labels, scripts, users). The app itself is one self-contained HTML file you host for free on GitHub Pages — the team opens a link, signs in, and gets a live dashboard of everything in flight.

## Google Cloud setup (one-time, ~15 minutes)

1. **Create the GCP project** — [console.cloud.google.com](https://console.cloud.google.com) → New project (e.g. `nexus`).
2. **Enable the Drive API** — APIs & Services → Library → "Google Drive API" → Enable.
3. **OAuth consent screen** — APIs & Services → OAuth consent screen → External → fill the app name/email → **Publish to Production** when prompted. Nexus only uses the `drive.file` scope (non-sensitive), so no verification, no unverified-app warning, no 7-day token expiry.
4. **OAuth client** — APIs & Services → Credentials → Create credentials → OAuth client ID → **Web application**. Add Authorized JavaScript origins:
   - `http://localhost:5173` (development)
   - `https://<yourname>.github.io` (production)
   - Copy the **client ID**.
5. **API key** — Credentials → Create credentials → API key. Then edit it:
   - **API restrictions**: restrict to *Google Drive API*.
   - **Website restrictions**: add your Pages URL and `http://localhost:5173/*`.
   - Copy the **key**.
6. **Create the GitHub repo** (public if you want free Pages hosting) and a **deploy target** — see "Deploying" below.

## Local development

```bash
npm install
cp .env.example .env.local    # fill in both values from the setup above
npm run dev                   # http://localhost:5173
```

First run: the app shows **Setup** → sign in with the Google account that will own the workspace (the *studio account*) → it creates the `Nexus Root` folder on Drive, link-shares it read-only, and creates `nexus.json` → create your admin login → paste the printed IDs into `.env.local`.

## Deploying (GitHub Pages, free)

The built artifact is a single `dist/index.html` — deployable anywhere static:

```bash
npm run build      # → dist/index.html
npx gh-pages -d dist --repo https://github.com/<you>/<you>.github.io.git
```

Common setups:
- **`<you>.github.io` repo**: push `dist/` there; the app lives at `https://<you>.github.io/`.
- **Project site**: push `dist/` to the `gh-pages` branch of any public repo → `https://<you>.github.io/<repo>/`.
- **Keep the source private**: build here, deploy only `dist/` to the public repo.
- Register the exact final origin in the OAuth client + API key restrictions (step 4/5) **before** sharing the link.

## Security model (honest version)

- **Editors/admins** sign in with the studio Google account (scope `drive.file`) and their Nexus app login. All writes flow through a verified read-modify-write loop with per-item merge — concurrent edits don't clobber each other.
- **Viewers** get a 256-bit capability token (a login link). They read through the API key — Google structurally denies writes to it. Only the token's hash is stored.
- **Not guaranteed**: viewer login gates the app, not the data (link-shared files are technically fetchable); the embedded API key is extractable (worst case: quota burn — restrict + rotate it); admin-vs-editor is procedural. Full details are rendered in-app at `#/security`.

## Operations

- **Backups**: `snapshots/` gets a daily copy of `nexus.json` (last 30). Restore via Admin → Maintenance.
- **API-key rotation**: create the new key → set it in Admin → Settings (key override) → verify → revoke the old key **last**.
- **Never** turn ON "Viewers can't download" in the Drive folder's sharing settings — it silently blocks all viewer reads (the app shows a banner naming it if it happens).
- **Statuses/labels/pipeline** are editable in Admin → Settings — workflow changes never need a redeploy.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck + single-file build to `dist/index.html` |
| `npm test` | Property tests for the sync/merge kernel |
| `npm run typecheck` | `tsc --noEmit` |
