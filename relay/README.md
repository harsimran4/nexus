# Nexus write relay

A tiny Deno Deploy service that lets **editors write with zero Google**: the
app posts merged saves here with a short HMAC ticket, the relay verifies the
editor's Nexus secret against the workspace's own credential hashes, and
writes `nexus.json` to Drive **as the studio account** via a stored OAuth
refresh token.

Reads never touch the relay — everyone reads through the public API key as
before. Admins/picker-connected editors keep using the direct Google write
path; the relay only kicks in when the tab has no Google session.

## Setup (one-time, ~10 minutes)

1. **Mint the refresh token** — from the project root:

   ```
   node scripts/get-refresh-token.mjs
   ```

   First, in Google Cloud Console → Credentials → your OAuth client:
   add `http://localhost:8899/` to **Authorized redirect URIs**, and copy the
   **client secret** (the script asks for it). Sign in with the **studio**
   Google account. The script prints everything you need for the next step.

2. **Deploy the relay** ([deno.com/deploy](https://deno.com/deploy) — free):

   - New project → paste `relay/main.ts` (or connect the repo with build
     entry `relay/main.ts`).
   - Settings → Environment variables: the five values the script printed
     (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
     `NEXUS_FILE_ID`, `TICKET_SECRET`).
   - Note the URL, e.g. `https://<project>.deno.dev`.

3. **Point the app at it** — add to `.env.local`, then rebuild + deploy:

   ```
   VITE_NEXUS_RELAY_URL=https://<project>.deno.dev
   ```

4. Editors just sign in with their Nexus secret as usual. At login the app
   exchanges the secret for a 7-day write ticket; from then on their writes
   flow through the relay. No Google popup, no Drive share, no picker.

## Security model (honest version)

- The relay holds the studio credential (refresh token) — it **is** the
  write path. Tickets are HMAC-signed, 7-day, and revoked by rotating
  `TICKET_SECRET`.
- `/verify` returns a ticket only for non-viewer app users; secrets are
  verified against the same argon2id/pbkdf2/sha256 hashes stored in
  `nexus.json`. Viewers can never get one.
- Possession of a ticket = write access for that user until expiry. It sits
  in the browser's localStorage — treat a shared computer accordingly.
- Rotate the studio credential by re-running the refresh-token script and
  updating the env vars.

## Scope

- `GET /health` — liveness + config check.
- `POST /verify {secret}` → `{ticket, role}` (401 on no match).
- `POST /write {baseVersion, doc}` (Bearer ticket) → `{version, md5Checksum}`,
  `409 {doc}` when the file moved since the client's last read (the app then
  merges and retries — same contract as the direct path).
- Media uploads still need the direct Google path (admin, or a
  picker-connected editor) for now.
