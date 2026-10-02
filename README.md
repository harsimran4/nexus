# Nexus

A content manager for small content teams. One OCI Object Storage bucket is the entire database: media lives in per-project prefixes, and a single `master/nexus.json` carries all metadata (groups, projects, statuses, labels, scripts, users). The app is a TanStack Start application deployed as ONE Cloudflare Worker — static SPA shell + server functions + server routes — with content stored in an OCI bucket over the S3-compatible API. The team opens a link, signs in, and gets a live dashboard of everything in flight.

## Architecture

- **App**: React + TanStack Router/Start, SPA mode (the Worker serves a prerendered shell as a static asset; server functions and routes run in the Worker itself).
- **Storage layout**: `master/nexus.json` (the doc), `groups/<groupId>/<projectId>/<fileId>__<name>` (media), `scripts/<id>.md`, `snapshots/` (daily doc copies), `trash/`.
- **Reads**: public same-origin routes (`/files/<key>`, `/api/public/*`) — the same exposure the old link-shared Drive folder had. Writes require a signed-in editor/admin and run as server functions that sign S3 requests with secrets only the Worker holds.
- **Auth**: app-issued logins; browser stretches passwords (600k PBKDF2) and the server sha256-compares — no KDF runs server-side. Sessions are 12h HMAC tokens.

## Setup (one-time)

1. **OCI bucket** — create an Object Storage bucket (e.g. `nexus`) in your region, then a **Customer Secret Key** (profile → Customer Secret Keys) — that gives you the S3-compatible Access Key / Secret Key pair and the bucket's endpoint URL (`https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com`).
2. **Cloudflare** — `wrangler login` with the account that will host the Worker.
3. **Local secrets** — `.dev.vars` (gitignored) next to `wrangler.jsonc`:
   ```
   OCI_S3_ACCESS_KEY_ID=...
   OCI_S3_SECRET_ACCESS_KEY=...
   SESSION_SECRET=<random 32 bytes: openssl rand -base64 32>
   SETUP_TOKEN=<random token — the /init gate>
   ```
   The non-secret vars (endpoint, bucket, region, PART_SIZE) live in `wrangler.jsonc`.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173
```

First run: the app shows **Init** → paste the SETUP_TOKEN → create your admin login (shown once — save it) → you're in. Create groups/projects, then invite people from Admin (logins for editors/admins, login links for viewers).

## Deploying

```bash
wrangler secret put OCI_S3_ACCESS_KEY_ID       # repeat for the other three secrets
npm run deploy                                  # build + wrangler deploy
```

The Worker serves the app and the API from one URL. Register that URL wherever you share login links from (`/login?vw=<token>`).

## Security model (honest version)

- **Editors/admins** sign in with their Nexus login; all writes run server-side with the Worker's OCI credentials — browsers never see them.
- **Viewers** get a 256-bit capability token (a login link). Only its hash is stored; reads go through the same public routes everyone uses.
- **Not guaranteed**: the workspace doc is publicly readable (password hashes in it are stretched; 256-bit tokens are safer); login rate limiting is per-isolate best-effort; admin-vs-editor separation is enforced by the signed token plus server re-checks. Full details are rendered in-app at `/security`.

## Operations

- **Backups**: `snapshots/` gets a daily copy of the doc (last 60). Restore via Admin → Maintenance.
- **Deleting**: project delete is metadata-only (restorable from the Archive); Purge is what moves files to `trash/`.
- **Never** rename keys in the OCI console — the doc's `fileIds` ARE the keys.
- **Statuses/labels/pipeline** are editable in Admin → Settings — workflow changes never need a redeploy.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server + workerd (local Worker runtime) |
| `npm run build` | Vite build, then `tsc --noEmit` |
| `npm test` | Property tests for the sync/merge kernel |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy` | Build + `wrangler deploy` |
