# P10 — real backups

Status: **BUILT (2026-10-20)** — the nightly cron export ships in the Worker; the OCI-side replication and the restore drills are operational procedures documented here for the deploy session. Nothing in this file requires code changes on deploy.

## The three layers

| Layer | What it covers | Recovery point | Owner |
|---|---|---|---|
| **D1 Time Travel** (primary) | All workspace state | Any minute in the last 7 days (free-plan window) | Cloudflare, automatic |
| **Nightly export** (this repo) | A human-readable doc snapshot in `backups/export-YYYY-MM-DD.json` | Daily, pruned to 14 | The cron in wrangler.jsonc |
| **OCI bucket replication** | Media bytes + script bodies | Hours (policy-dependent) | OCI console, one-time setup |

## 1. D1 Time Travel — enable + drill

Time Travel is ON for every D1 database by default; nothing to enable. Free plan keeps a 7-day window.

Drill (do this once after the first deploy, then after any scary incident):

```bash
# see the restorable window
npx wrangler d1 time-travel info nexus --remote

# restore to a timestamp (REPLACES the current database — do it in a calm moment)
npx wrangler d1 time-travel restore nexus --remote --timestamp "2026-10-21T14:30:00Z"
```

After a restore: the derived `master/nexus.json` may lag the restored D1 — one admin call fixes it: `POST /api/debug/d1?op=import` (re-imports from the doc), or flip set-stage to force a write-through. Verify with `GET /api/debug/d1?op=diff` → clean.

## 2. The nightly export (what the cron does)

`wrangler.jsonc` schedules the Worker daily at 03:17 UTC. `src/server/backup.ts` regenerates the doc from D1 (the exact same one-batch read the write-through uses) and puts `backups/export-<day>.json`, pruned to the newest 14 files. A `lastBackup` meta row (`{at, rev, key}`) records freshness — visible via `wrangler d1 execute nexus --remote --command "SELECT * FROM meta WHERE key='lastBackup'"`.

Restore from an export: the file IS a nexus.json. Admin → Maintenance can restore from a doc snapshot; for a raw export, put it back and re-import:

```bash
# inspect before touching anything
npx wrangler r2 object ... # (OCI: use the console or oci cli) — download backups/export-2026-10-21.json
# then in the app: Admin → Maintenance → restore, or POST the file's content via /api/debug/d1 import
```

## 3. OCI bucket replication — media bytes (one-time, OCI console)

The Worker runs on Cloudflare's free plan — it cannot (and must not) copy media bytes around (50-subrequest budget). Replication belongs to OCI:

1. OCI console → Object Storage → **Retention Rules** (simplest, immutable holds) or a second bucket + **Replication Policy** (cross-region).
2. Recommended: a replication policy from `nexus` to `nexus-dr` in a second region. The replica bucket is read-only from this app's point of view — restore = repoint `OCI_S3_BUCKET` (or copy objects back).
3. Verify once: upload a file, check it appears in the replica within the policy's window.

## What is NOT backed up (honest list)

- **Viewer/viewer-token knowledge of revocations** — everything in D1 IS in the backups (viewers table included); nothing extra needed.
- **Uploads in flight** during an incident — multipart parts not yet completed are not in D1 or the doc; they're retryable by design.
- **The 7-day Time Travel window** — after 7 days, the nightly exports are the only history. For longer history, extend `BACKUP_KEEP` in backup.ts (free storage is trivial at a few MB per export).
