# Phase 4 — bot runner ported from Firebase to Supabase (2026-11-22)

`runner/run-cycle.mjs` now runs entirely on Supabase: Supabase Auth
(email/password, same `RUNNER_EMAIL` / `RUNNER_PASSWORD` secrets),
PostgREST reads/writes through a small `sb*` helper layer copied from
`src/api.js`, and the unchanged `src/botLogic.js` + `src/aiProviders.js`
for decisions, prompts and the provider router. No Firebase imports
remain. `.github/workflows/bot-runner.yml` is unchanged except one
comment line (Firestore → Supabase); schedule (`*/10 * * * *`), TZ and
Node 20 are untouched.

## What could NOT be verified yet

The Supabase Auth users do not exist yet — the Phase 5 data import
creates them later tonight — so NOTHING in the ported runner has run
against the live project. Verified locally only:

- `node --check runner/run-cycle.mjs` passes.
- With no env vars set, the script loads every import (supabase-js,
  `../src/supabase.js`, `../src/utils.js`, botLogic, aiProviders) and
  exits with the expected `RUNNER_EMAIL / RUNNER_PASSWORD secrets are
  not set` message — i.e. module resolution and top-level code are
  sound in plain Node 20, nothing more.

Unverified against live Supabase, specifically:

- `signInWithPassword` for the MeetBook Official account and the
  subsequent `public.users` role read (the admin/superadmin guard).
- Every RLS admin branch the cycle depends on: botRunners claim
  upsert, botSettings/botSecrets/botBrains/botMemories admin
  read/write, posts/messages/notifications admin-as-bot inserts,
  users_insert_admin_bot for `ensureBotUserDoc`. These were checked
  against `supabase/policies.sql` by eye, not by execution.
- The claim race in production (two claimants, one window) — the
  upsert-with-`ignoreDuplicates` pattern is the same one the browser
  runner uses, but it has not been raced live from Actions yet.
- AI provider calls from the Actions network with the imported
  botSecrets keys (carried over from the old runner unchanged, but
  the keys only land in Supabase with the import).

## Post-import smoke check (run ONCE, after the data import)

1. GitHub → mamun-q/MeetBook → Actions → **Bot runner** → **Run
   workflow** (workflow_dispatch) on `main`.
2. Open the run's "Run one bot cycle" step log. Expected, in order:
   - `Signed in as meetbook.official@example.com (role: superadmin).`
   - Then EITHER `Bot cycle skipped: this window was already claimed
     by another runner.` (fine — an admin browser cycle claimed the
     same 3-minute window first) OR `Bot cycle complete: …` with a
     per-bot summary (`→ message` / `→ post` / `→ none (…)` entries).
   - A trailing `AI failure: … (template fallback used)` on the
     complete line is acceptable on the first runs (provider hiccup),
     as long as the cycle completes.
3. Failure signatures to treat as a broken port:
   - `Bot cycle failed: …` with an auth error (`Invalid login
     credentials`, `Email not confirmed`) → the import did not create
     / confirm the Official auth user correctly.
   - `Runner account … is not an admin (role: …) — refusing to run.`
     → the imported `public.users` row for Official is missing or its
     role did not survive the import.
   - Any `Bot cycle failed:` line naming a table or a PostgREST code
     (`42501`, `PGRST…`) → an RLS policy gap; note the table named and
     stop the schedule until it is fixed (disable the workflow from
     the same Actions page).
4. If the log is healthy, also confirm in the app (Admin → AI Bots)
   that the last-cycle summary / decision history updated — the
   runner's decisions land in `botRunners/decisions_<botId>` exactly
   like the browser runner's.

## Behaviour differences forced by the backend (deliberate)

- **Post rows lose the `generatedBy` stamp.** The Firestore post doc
  carried `generatedBy: <provider>`; the Postgres `posts` table has
  no such column and PostgREST rejects unknown columns, so the insert
  omits it (the Phase 5 import drops it from historical posts too).
  The provider that produced each text is still stamped in
  `botBrains` after every generation. NOTE: `src/api.js`'s live cycle
  still passes `generatedBy` in its posts insert (line ~4080) — if
  that insert errors live, this is why; fixing `src/` was out of
  scope for Phase 4.
- **Client-generated ids.** Messages, posts and notifications used
  Firestore `addDoc` (server ids); they now use the app's `genId()`
  prefixes (`m_…`, `p_…`, `n_…`, `c_…`), exactly like the browser
  runner's Supabase cycle.
- **Likes are read-modify-write.** No `arrayUnion` in PostgREST; the
  like appends to the freshly queried row's `likes` and writes the
  whole array back, mirroring `src/api.js`.
- **Counters save is a per-bot read-merge** (read stored row, spread
  this cycle's counters over it, upsert) instead of Firestore's
  recursive deep merge — this is `saveLiveBotCounters`' semantics,
  adopted on purpose so the two runners can never diverge.
- **Thread context query is ordered** (`createdAt` asc, limit 50)
  instead of Firestore's unordered limit-50 + client sort; same 50
  messages for any thread under the cap.
