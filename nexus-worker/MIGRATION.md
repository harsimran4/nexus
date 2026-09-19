# Nexus → Worker-backed Drive access

What this changes: editors/admins stop needing the studio Google account at
all. They keep logging in with the app token/password they already have.
Every Drive write now goes through a small Cloudflare Worker that holds the
real Google credential — nobody's browser ever sees it.

Nothing about your Drive folder layout, `nexus.json` schema, or UI pages
changes. Viewers are completely unaffected (still read via the embedded API
key, exactly as today).

## Order of operations

**Do this in order — the Worker needs `nexus.json` to already exist.**

### 1. Keep your existing workspace as-is
Your current `Nexus Root` folder, `nexus.json`, and its file ID are reused —
you are not recreating the workspace.

### 2. Create a "Desktop app" OAuth client (for minting the refresh token)
In the same GCP project as your existing OAuth client:
APIs & Services → Credentials → Create credentials → OAuth client ID →
**Desktop app**. Copy its client ID + secret.

(This is separate from your existing Web-application client — that one still
handles the one-time `#/init` bootstrap and doesn't need to change.)

### 3. Mint a refresh token for the studio account
```bash
cd nexus-worker
npm install
GOOGLE_CLIENT_ID=<desktop-client-id> GOOGLE_CLIENT_SECRET=<desktop-client-secret> \
  npm run get-refresh-token
```
A browser tab opens — **sign in as the studio account** (the one that owns
`Nexus Root` today) and approve. The script prints a refresh token. Keep it
somewhere safe for the next step; don't commit it anywhere.

### 4. Deploy the Worker
```bash
npx wrangler login
# Edit wrangler.toml: paste your existing VITE_NEXUS_FILE_ID into NEXUS_FILE_ID
npx wrangler secret put GOOGLE_CLIENT_ID        # the Desktop client id from step 2
npx wrangler secret put GOOGLE_CLIENT_SECRET    # its secret
npx wrangler secret put GOOGLE_REFRESH_TOKEN    # from step 3
npx wrangler secret put SESSION_SECRET          # any random 32+ byte string, e.g. `openssl rand -base64 32`
npm run deploy
```
Wrangler prints your Worker's URL, e.g. `https://nexus-drive-proxy.<you>.workers.dev`.

### 5. Patch the app
- Replace `src/drive/client.ts` with `patched-src/drive-client.ts` (rename to `client.ts`).
- Replace `src/auth/session.ts` with `patched-src/session.ts`.
- Replace `src/config.ts` with `patched-src/config.ts`.
- In `src/drive/bootstrap.ts`: change every parameter typed as
  `cred: { mode: 'bearer' }` to `cred: Credential` (it's already imported).
  The functions just forward `cred` to `client.ts`, so no logic changes —
  only the type annotation, so `Init.tsx` can pass `mode: 'google'`.
- In `src/ui/pages/Init.tsx`: change the four calls that currently pass
  `{ mode: 'bearer' }` (`findWorkspace`, `readFile`, `createWorkspace`,
  `trashFile`) to `{ mode: 'google', bearer: getBearerToken() }`
  (import `getBearerToken` from `../../auth/tokenClient`). This is the one
  remaining place that talks to Google directly — intentional, since it's the
  one-time setup step, run once by you.
- In `src/App.tsx` and `src/ui/pages/ProjectPage.tsx`: remove the "Connect
  Google (studio account)" button/banner — editors no longer need it. (Leave
  `auth/tokenClient.ts` in the codebase; `Init.tsx` still uses it.)
- Add to `.env.local` (and wherever your GitHub Actions/build secrets live):
  ```
  VITE_NEXUS_WORKER_URL=https://nexus-drive-proxy.<you>.workers.dev
  ```

### 6. Rebuild and redeploy the static site as usual
```bash
npm run build
npx gh-pages -d dist --repo https://github.com/<you>/<you>.github.io.git
```

### 7. Lock down CORS
Once the Pages URL is confirmed working, edit `wrangler.toml`:
```
ALLOWED_ORIGIN = "https://<you>.github.io"
```
and `npm run deploy` again. Until then it's wide open (`*`), which is fine for
initial testing but not for production.

## What your editors do differently now

Nothing extra — they open the same link, log in with the same token/password
an admin gave them, and uploads/writes just work. There's no "Connect Google"
step for them anymore.

## Operational notes

- **Rotating the studio credential**: if you ever need to revoke it, revoke
  access at https://myaccount.google.com/permissions, rerun step 3 for a new
  refresh token, and `wrangler secret put GOOGLE_REFRESH_TOKEN` again. No
  editor is affected — they never held this credential.
- **Disabling a user**: takes effect within ~60 seconds (the Worker re-checks
  `nexus.json` on that cadence), not instantly — a small trade-off for not
  re-reading the doc on every single request. Tune the 60_000ms constant in
  `getCachedDoc` in `src/index.js` if you want it tighter.
- **Cost**: Cloudflare Workers free tier is 100,000 requests/day. A small
  content team won't get close to that.
- **The API key**: still embedded for viewer reads, as before. If you want to
  remove that exposure too later, route viewer reads through the Worker's
  `/session` (it already recognizes viewer tokens) and add read-only
  `/drive/*` routes — happy to help with that as a follow-up.
