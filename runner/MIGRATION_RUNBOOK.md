# MeetBook Phase 5 — Data Migration Runbook

_One-off run: Firestore (meetbook-5f491) → Supabase (project ref `ouyuijpxhhvtnxnvavza`, https://ouyuijpxhhvtnxnvavza.supabase.co). Do these steps in order, the night of the cutover._

## Design note (read first)

Auth users are created with the **same id as the Firestore uid** (Admin API), so `public.users.id = auth.uid()` and **no reference anywhere needs remapping** — post authors, conversation participants, bot ids, deterministic DM ids (`dm_<uidA>_<uidB>`) all survive unchanged. This supersedes the uid-remap paragraph in MIGRATION_PLAN.md design decision #4. Bot users get **no** auth user — they act through admin sessions, exactly as today.

## Run order

1. **Export** — GitHub → repo `MeetBook` → Actions → **"Export Firestore (Phase 5 migration)"** → Run workflow.
   - Uses the existing `RUNNER_EMAIL` / `RUNNER_PASSWORD` secrets (MeetBook Official admin) — nothing new to configure.
   - The script refuses to run if the account is not admin/superadmin, and **fails the run if any collection cannot be read** (no partial artifact).
2. **Download** the `firestore-export` artifact from the finished run, unzip, and put `firestore-export.json` at the repo root (or point `EXPORT_FILE` at it).
   - ⚠️ This file contains **all user data + the live AI provider keys** (from `botSecrets/config`). Treat it like a secret.
3. **Set env** (values from the Supabase dashboard → Project Settings → API → `service_role` key; env only — **never commit the service key or any password**):
   ```bash
   export SUPABASE_URL="https://ouyuijpxhhvtnxnvavza.supabase.co"
   export SUPABASE_SERVICE_KEY="<service_role key>"
   export OFFICIAL_PASSWORD="<MeetBook Official password>"
   export TEST_PASSWORD="<MeetBook Test password>"
   ```
4. **Import** — from the repo root:
   ```bash
   node runner/import-to-supabase.mjs
   ```
   - Creates the auth users first, then upserts all 27 tables in dependency order. Safe to re-run (auth skips existing users; rows upsert on the id PK).
   - Exit code is `1` if anything failed — do not proceed to cutover until the log is understood.
5. **Verify** — the script ends with a per-table **export vs DB count comparison**. All rows must show ✓. Also spot-check in the Supabase dashboard: `botSecrets` has its `config` row (do not print/share its contents), one known post, one DM thread, and the six bot rows in `bots`/`users`.
6. **Clean up** — delete the local `firestore-export.json` **and** the GitHub Actions artifact (it auto-expires in 7 days, but delete it immediately after a verified import).

## Passwords — who has one after migration

| Account | Password after import |
|---|---|
| MeetBook Official (`meetbook.official@example.com`) | Set from `OFFICIAL_PASSWORD` — known (Muse-created), logs in immediately |
| MeetBook Test (`meetbook.test@example.com`) | Set from `TEST_PASSWORD` — known (Muse-created), logs in immediately |
| Limon's accounts (`@md.mamun`, `@mdmamunhossenlimon7`) | **None** — use **forgot-password** on the new site after cutover |
| Inbox Tester (`support.tester@example.com`) | **None** — forgot-password (throwaway test account) |
| The six bots | No auth user at all — unchanged from today |

If `OFFICIAL_PASSWORD` / `TEST_PASSWORD` env vars are left empty, those accounts also fall back to forgot-password and the script prints a warning.

## Expected mapping warnings

- `posts.generatedBy` (bot posts stamp the AI provider that wrote them) has **no column** in the posts table and posts has no overflow column → dropped with a warning per affected post. Nothing else is lost.
- Any other warning line names the table, doc id and field — review them before cutover; unknown fields on `config/app` are NOT warnings, they land in `config.extra`.
