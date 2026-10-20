# P4 — D1 migration design (the spine)

Status: **STAGES 1–3 BUILT, ALL THREE MODES VERIFIED LOCALLY (2026-10-20)** — the FULL e2e suite passes in stage-1 mode (doc writer + shadow mirror), stage-2 mode (`E2E_STAGE=2`, gateway writes), and stage-3 mode (`E2E_STAGE=3`, D1 boot reads + gateway writes + whole-doc writes refused). 102/102 unit tests, tsc clean, worker ~1.05MB gzip / 2.50MB limit. The stage flag lives in D1 meta (`stage` row, default '1'); the client probes per session and falls back gracefully at every level — no doc schema change, no client flags.

**Schema additions since the first cut (2026-10-20):** `comments` table (P7 — top-level doc collection, per-entry LWW like refs; a thread embedded on the project would be clobbered by whole-project LWW), `projects.approved_at/approved_by` (P7 single-slot approval), `viewers.scope` (P8 — '' = whole workspace, else one project id). 15 tables total. LOCAL DEV NOTE: these were added before any deploy, so `0001-schema.sql` was edited in place — a local `.wrangler/state/v3/d1` that predates the change must be wiped once (or tables lack the new columns and the mirror/diff fail loudly).

**P8 scope enforcement is TWO-sided (2026-10-20, after a hand-review found the hole):** the server filter in `scopedBootstrapFn` is the enforcement — but it only guards the share-link ENTRY. A scoped tab that reloaded `/project/<id>` used to run the NORMAL boot (public doc read → whole workspace; plus any P6 cached snapshot repainted instantly). Fix: `src/sync/scoped.ts` — the scoped session persists (`nexus.scopedSession`) and `boot()`/`revalidateBoot()` divert to `bootScoped()`/`refreshScoped()`, which read ONLY through the scoped fn and never touch the public read, the boot cache, the poller, the hub, or session restore. Revoked links clear the session and block with a banner. The sidebar chrome reduces to the board for scoped tabs (UX, not enforcement). KNOWN RESIDUAL (accepted, pre-existing posture): the doc itself remains anonymous-readable at `/files/master/nexus.json` by the app's open-by-URL design — a determined user with devtools can fetch it manually regardless of scope. Sealing that read is a separate product decision (it would end public viewing), not part of P8.

## Stage 3 — what exists now

- `bootstrapFn` (fns.ts) — the boot snapshot: readAllRows is ONE D1 batch (one consistent view), rowsToDoc, return raw. Below stage 3 (or no binding) it answers `{stage}` only and the client falls back to the bucket doc — one probe, no flags.
- `docPutFn` gate — at stage ≥ 3 whole-doc writes return `permission`; `writer.ts` maps that to the EXISTING read-only status path. An old pre-flip tab goes read-only with a 'reload to keep editing' message; a reload brings the gateway client.
- `boot.ts` — tries bootstrapFn first; parse/schema-gate; falls back to the bucket read (which stays true via write-through).
- `set-stage&value=3` — one admin call flips reads; write-through continues (the bucket doc stays true for pollers/auth reads — its retirement to a nightly export is P10).
- Poller/auth reads unchanged — the write-through keeps the bucket doc true, so only BOOT moved to D1 (the cheapest, safest read flip).

## Stage 2 — what exists now

- `src/server/d1/apply.ts` — the wire-op compiler + validator: table/column allowlists (TABLE_SPECS), LWW-guarded upserts, guarded deletes (full-key), prefix deletes for child tables, admin-only strong deletes/meta-del/activity-del (restores are wholesale), activity sha256 dedupe, server-authoritative rev/docStamps (clients can never send them), 500-op cap.
- **The stamp-dialect LWW rule (load-bearing):** legacy ISO stamps ('2026-01-01T…') and HLCs ('1792428…') both exist in real docs, and lexical compare ranks EVERY HLC under every ISO stamp ('1' < '2'). The kernel's actual rule — an HLC always beats a non-HLC stamp — is encoded in SQL as `… > x OR (x NOT GLOB '*[^0-9.]*' AND y GLOB '*[^0-9.]*')`. NOTE GLOB semantics: `'[0-9.]*'` only constrains the FIRST char ('2026…' matches!); the whole-string test is `NOT GLOB '*[^0-9.]*'`. Both bugs shipped and were caught by the stage-2 e2e run (writes silently no-op'd) — the GLOB one was proven against live D1 before fixing.
- `src/server/d1/tables.ts` — `wireDiff` is THE one doc→transition diff (the mirror and the gateway share it; apply.compileOps is THE one SQL compiler). Gateway-scoped diffs omit server-authoritative meta (rev/docStamps/schema — the poller moves local rev, so a gateway diff containing rev ops would be rejected forever).
- `mutateFn` (fns.ts) — auth + role gate, stage gate (soft-refuses below 2 → client falls back), validate → compile → ONE D1 batch with bookkeepingOps (rev bump + docStamps) → writeThrough (regenerate doc from D1, put, verify, ≤3).
- `src/sync/gateway.ts` (client) — baseline tracking (boot doc, advanced only on confirmed sends), wireDiff → mutateFn → setBase(etag); mode 'unknown'→'d1'/'doc' per session; non-retryable rejections demote to the legacy writer (which surfaces failures honestly), transient ones queue.
- `linking.ts` stage-2 branch — guest/app upload links go INSERT OR IGNORE → D1 batch → writeThrough; the whole verify-then-write CAS loop is stage-1-only now.
- e2e: `E2E_STAGE=2` flips the deployment in globalSetup (forged admin token — epoch must match the seeded user's sessionEpoch) AFTER a full import; `scripts/e2e-global.mjs` also always aligns D1 pre-suite, so isolated spec runs are valid.

## Stage 1 — what exists now (2026-10-18/19)

- `migrations/0001-schema.sql` — 14 tables incl. `snapshots`, `deletions`, `activity.h` (content-hash identity, UNIQUE), `deleted_at` **+ `deleted_by`** on every soft-deletable table (the doc's `deleted:{at,by}` must round-trip).
- `src/server/d1/tables.ts` — THE doc↔rows registry: `docToOps`/`importActivityOps` (full import), `mirrorOps` (diff-based transitions; **deletes are emitted child-first, inserts parent-first — D1 enforces FKs inside the batch transaction**), `rowsToDoc` (explicit field-by-field regen — a schema drift must fail the diff, not smear SQL names into the doc), `diffDocs` (keyed/set compare; activity as hash SETS — order across concurrent writers is not semantic), `renderSql` (CLI importer renders literals), `canonicalJson`/`activityHash`.
- `src/server/d1/mirror.ts` — `applyOps` (40-stmt chunks, hard 45-batch valve) + `mirrorDocChange` (NEVER throws into the write path; skips rev-equal transitions; logs `[d1-mirror] <why>: N statements`).
- `src/server/d1/regen.ts` — reads all tables (activity newest-1500).
- Hooks: `docPutFn` (parses the doc it's about to overwrite; absent→null full-insert; unreadable→skip that transition), `initFn` (null→doc), `linking.ts` (verifies post-put state, mirrors `structuredClone(doc)` BEFORE its in-place mutations → `verifyDoc` — **the linker mutates `doc` in place, so a pristine snapshot is required or the rev-equal guard silently eats the transition; this bug shipped and was caught by the e2e shadow spec**).
- `/api/debug/d1` route (admin-only): `GET ?op=diff|regen`, `POST` = wipe+import then diff.
- `scripts/import-doc-to-d1.mjs` — imports `tables.ts` DIRECTLY (Node ≥22 strips types) so importer and mirror cannot drift; full reconcile = child-first wipe + INSERT OR REPLACE.
- e2e: `scripts/e2e-stack.mjs` applies the schema to local D1 before `wrangler dev`; `e2e/shadow.spec.ts` = import → diff clean after each mutation class (rename, notes, ref, script milestone, real upload through linking, snapshot restore).
- **Test-order dependency (important when grepping specs):** every `up` reseeds the BUCKET but D1 persists → the `import` test must run before any diff assertion (it re-aligns D1). Isolated greps of later specs diff fresh-doc vs stale-D1 and diverge — not a product bug.

## Stage 1 — open items

- Full-suite e2e run (15+7 specs incl. shadow) to confirm green after the linking `docBefore` fix.
- Shadow period in DEPLOYMENT (N clean days of `/api/debug/d1?op=diff`) before stage 2 flips anything.
- Remote database: `npx wrangler d1 create nexus` → paste real `database_id` into `wrangler.jsonc` (placeholder UUID works for local dev/e2e only).
- Accepted stage-1 residuals: chunk borders are not atomic (converges; diff is the arbiter); two racing docPuts can interleave mirror batches (rare, loud, repaired by re-import); a group hard-delete whose projects still reference it aborts the batch loudly (FK) — only possible at tombstone-GC time.

## Why

Everything hangs off `master/nexus.json`: every edit re-uploads the whole doc; the CAS race (OCI ignores If-Match) is structural and caused the 97-file incident; search can't be indexed; permissions are doc-level; the doc only grows. Cloudflare D1 (SQLite) removes the entire class: real transactions, O(change) writes, per-entity revisions, server-side queries, per-entity permissions. The bucket keeps media bytes and script bodies.

## Schema

Mapped from `src/types/schema.ts` (the zod doc is nearly table-ready):

| Table | Contents | Notes |
|---|---|---|
| `meta` | key PK / value | schema version, workspace `rev`, and `settings` as ONE JSON row (settings already merge whole-value; exploding to columns is churn) |
| `groups` | stamps + name/description/color/folder_id | `deleted_at` replaces `deleted:{at,by}` |
| `projects` | stamps + group_id/name/status/folder_id/labels(JSON)/assignee/due_at/notes | |
| `media_sections` | (project_id, id, name, sort) | child table |
| `project_files` | (project_id, file_key, section_id, added_at, added_by, PK(project_id, file_key)) | merges `fileIds` + `mediaSectionOf`; **the table that deletes linking.ts** — linking = `INSERT OR IGNORE`, atomic by construction |
| `scripts` | stamps + title/project_id/status/storage(JSON: type+fileId or inline body) | bodies stay as files for `md`; `inline` keeps body in JSON |
| `script_copies` | (script_id, file_id, label, at) | frozen milestone copies |
| `users_app` | auth(JSON: kind/hash/salt/iterations), session_epoch, disabled | verbatim from appUserSchema |
| `viewers`, `upload_links`, `refs` | 1:1 with their zod schemas | token hashes unchanged |
| `activity` | (seq INTEGER PK AUTOINCREMENT, at, actor, verb, ref, meta JSON) | ring becomes `ORDER BY seq DESC LIMIT n` + cron prune; the 300/1500 inconsistency dies |
| `deletions` | (id, type, at, by) | tombstones map 1:1 — server truth uses hard DELETE, but the offline outbox needs "never existed" vs "was deleted" (`NOT EXISTS deletions` = today's tombstone-beats-resurrection rule); 90-day GC cron |
| `extra` columns | passthrough JSON | the doc deliberately preserves unknown fields; the importer must land them or the diff check fails loudly |

## Cutover — staged mirror-then-flip (never big-bang)

The doc can be REGENERATED from D1 mechanically, which makes every stage rollback-able:

1. **Shadow (doc = truth).** Deploy D1 + the importer. Every confirmed write additionally mirrors into D1 in one batched transaction — **diff-based** (changed rows only; the 100k row-writes/day free quota survives heavy editing). Ship `GET /api/debug/diff` (regenerate doc-from-D1, deep-compare vs the real doc, report first divergence). Run N consecutive clean days.
2. **Flip writes.** Mutations become transactional server fns; each write-through regenerates `master/nexus.json` from D1 and puts it, so pre-flip tabs and rollback both still work.
3. **Flip reads.** Boot reads the D1 bootstrap endpoint (ONE transactionally consistent snapshot — losing "one doc = consistent read" is a listed risk). `docPutFn` returns **410** when a meta flag says stage ≥ 3; old tabs fall to the EXISTING `readOnly` status path (reuse `src/sync/store.ts`, don't invent). `master/nexus.json` becomes a derived nightly export (P10).

## Code fate

- **`src/server/linking.ts` — deleted wholesale** (with `link-batch`'s machinery; stub the route for one guest-page generation). `project_files` INSERT is the link. The whole 6-attempt CAS / post-put self-verify / batch-repair apparatus — built for the incident — becomes unnecessary by construction. P3b's server repair is acknowledged throwaway.
- **`src/sync/writer.ts` — dies, almost entirely.** `commit()`'s mutator → debounce → whole-doc CAS → rebase loop → quarantine is replaced by a **mutation gateway**: small queue → server fns, optimistic local apply, reconcile from the response. `snapshotHook` dies (Time Travel + nightly export). `discardPendingForLogout` shrinks to "clear the outbox".
- **`src/sync/merge.ts` — survives, shrunk.** Per-entity LWW + tombstone rules compile into SQL guard clauses for the offline outbox: the client sends `{op, entity, hlc}` and the server applies `WHERE updated_at < :hlc` / `NOT EXISTS (deletions)`. The kernel's correctness work is not wasted — it moves client-side (drafts/outbox) and server-side (guard clauses). Doc-level merge (settings/activity/snapshots/users arrays) is deleted.
- **`src/state/actions.ts` — the real XL.** ~40 `commit()`-based actions, every UI call site assuming synchronous local-doc mutation. Each becomes an RPC wrapper + optimistic apply. Migrate action-by-action behind the gateway seam.
- **`src/sync/poller.ts` — survives as fallback** (P5 demotes it to 30s vs `/api/rev`); `sweepAutoArchive` moves server-side; `reverifySessions` reads D1.
- **`src/sync/drafts.ts` — survives verbatim** (tab-close write recovery + script drafts are orthogonal to server truth).
- **Auth — essentially unmoved.** HMAC tokens stateless; `SESSION_SECRET` stays a secret; login becomes a point query (cheaper than today's whole-doc read); `session_epoch` column carries over; PBKDF2 client stretch untouched; login throttle stays per-isolate until optionally persisted.

## Risks & mitigations

1. **actions.ts rewrite is the bulk** → mutation-gateway seam; action-by-action migration; extend the fast-check property tests to outbox replay.
2. **Same-day stale clients writing to the doc after flip** → git-SHA appVersion (P1 ✓) + the 410 readOnly gate.
3. **Unknown passthrough fields** → `extra` JSON columns; the diff check fails loudly rather than silently dropping.
4. **Bootstrap consistency** → one D1 batch = one read transaction = one response.
5. **Mirror-stage quota blowout** → diff-based mirroring from day one; never whole-doc-per-save.

## Free-plan budgets (why this fits)

D1 free: 5GB storage, 5M rows-read/day, 100k rows-written/day. A 22-project workspace is trivially inside; the diff-based mirror keeps writes two orders of magnitude under quota. D1 Time Travel (PITR) is included — P10's database backup becomes "enable + drill".

## Effort

**XL total:** schema + importer M · gateway/actions rewrite L · staged cutover + gating M. The D1 binding arrives as a wrangler.jsonc `d1_databases` entry; local dev uses wrangler's built-in local D1 (no account needed) — the e2e stack keeps working with `seedWorkspace()` swapped to SQL inserts.
