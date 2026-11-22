-- =====================================================================
-- fix-user-email-exposure.sql — Security hardening (2026-11-22 audit)
-- STATUS (as of 2026-11-22):
--   Section 1 (admin_user_emails RPC): APPLIED 2026-11-22 — live.
--   Section 3 (botSettings read tightening): APPLIED 2026-11-22 —
--     live (botSettings reads are admin-only).
--   Section 2 (users column-level grants): READY TO APPLY. It was
--     applied once on 2026-11-22 and ROLLED BACK within the hour
--     (see the PostgREST warning below — it broke every users read),
--     but the companion app patch has since landed: src/api.js reads
--     users with the explicit granted-column list, and
--     runner/run-cycle.mjs + the instant responder carry the same
--     substitution in their sb* helper copies (pinned by
--     tests/users-column-grants.test.js). Applying section 2 alone
--     now leaves the app fully working — the only visible change is
--     that non-admin clients stop receiving emails in the users
--     mirror, which the app already tolerates (own email comes from
--     Auth, admin emails from the section-1 RPC). Run ONLY section
--     2 in the dashboard (steps at the bottom); sections 1+3 are
--     already in effect.
--
-- ⚠ PostgREST select=* behaviour (learned live, the hard way):
-- under COLUMN-only grants, PostgREST does NOT quietly omit the
-- ungranted column from select=* — it rejects the request ENTIRELY
-- with 42501 "permission denied for table users". The same applies
-- to a write's RETURNING * (Postgres needs SELECT privilege on
-- every returned column). The original version of this file claimed
-- the opposite, and the app — which read users via select=* — broke
-- the moment the grants landed. The app now names the granted
-- columns explicitly for every users select AND every users
-- write-returning select, which is what makes re-application safe.
-- A corollary for verification: after re-application, a manual
-- select=* probe on users returning 42501 is the lockdown WORKING,
-- not a regression — probe with the explicit column list instead.
--
-- FINDING (verified live, 2026-11-22): any signed-in user can read
-- every user's EMAIL address via PostgREST:
--   GET /rest/v1/users?select=id,username,email   (as MeetBook Test)
--   -> HTTP 200, 12 rows, 3 non-empty emails of OTHER users exposed
--      (incl. the owner's personal Gmail).
-- Root cause: policy `users_select_all` grants SELECT on the whole
-- row `using (true)` to `authenticated`, and RLS is row-level — it
-- cannot hide a single column. The app also mirrors the full users
-- table (emails included) into every signed-in client.
--
-- FIX STRATEGY (two layers, both in this file):
--   1. An admin-only RPC `admin_user_emails()` so the Admin panel can
--      keep showing/searching emails after the direct column closes.
--   2. Column-level privileges: `authenticated` keeps SELECT on every
--      users column EXCEPT `email`. An explicit `select=email`
--      returns HTTP 403 (42501), and so does `select=*` (see the
--      warning above) — the app therefore never uses either on this
--      table. INSERT/UPDATE privileges are untouched, so
--      registration (which writes the email) keeps working, and the
--      SECURITY DEFINER helpers (users_row(), group_discovery(), …)
--      run as the function owner and are unaffected.
--
-- dob and settings deliberately stay readable in this pass:
--   - settings is the signed-in user's own synced prefs object; the
--     app reads it back from the users row every session. Moving it
--     needs its own migration (a self-only table) — separate job.
--   - dob is shown on profiles by design (birthday row). It is PII;
--     if Limon wants it hidden too, add `dob` to the exclusion list
--     below (profile birthday rows will simply render empty).
--
-- REQUIRED COMPANION APP PATCHES (BOTH are now implemented in the
-- app; the push of #2 is what gates re-application):
--   1. The email patch: Admin → Users sources emails from the
--      admin_user_emails() RPC, own-email displays from the Auth
--      user (details in (a)–(c) below). Shipped 2026-11-22.
--   2. The column-list patch: every users read/write-returning
--      select in src/api.js (and the runner + responder helper
--      copies) names the section-2 grant list explicitly instead
--      of '*'. Without THIS patch the SQL breaks the whole app
--      (see the select=* warning above); with it, nothing degrades.
-- Original email-patch notes (ship BEFORE or WITH this SQL —
-- without it, two admin conveniences degrade, nothing else breaks):
--   a. Admin → Users table + search (src/views.js, the users table
--      rendering `u.email` and the search filter matching on email):
--      fetch emails via rpc admin_user_emails() for staff sessions
--      and merge by id. Until patched, admin email cells render
--      empty and email search stops matching (names/usernames fine).
--   b. Own email displays (settings/profile headers render
--      `meUser.email`): source it from supabase.auth.getUser()
--      (the Auth user object always carries the account email)
--      instead of the mirrored users row. Until patched, those two
--      spots render blank for everyone.
--   c. The demo-mode duplicate-email pre-check in src/api.js reads
--      the mirrored users list; in LIVE mode it becomes a no-op once
--      emails stop mirroring. Supabase Auth remains the real
--      uniqueness gate (duplicate sign-up fails server-side), so
--      this is cosmetic — no action strictly required.
--
-- WHAT DOES NOT CHANGE: profiles (names, usernames, avatars, bios)
-- stay readable by all signed-in users — that is the app's design
-- (the feed needs them). Anon keeps having NO access at all (probe:
-- HTTP 401). Bots' rows carry empty emails already.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Admin-only email lookup for the Admin panel
--    STATUS: APPLIED 2026-11-22 (idempotent — safe to re-run).
-- ---------------------------------------------------------------------
create or replace function public.admin_user_emails()
returns table (id text, email text)
language sql
security definer
set search_path = public
stable
as $$
  select u.id, u.email
  from public.users u
  where public.is_admin()
$$;

revoke execute on function public.admin_user_emails() from public, anon;
grant execute on function public.admin_user_emails() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Close the email column to the `authenticated` role
--    (every other column keeps its current SELECT privilege)
--    STATUS: READY TO APPLY (see the status block at the top).
-- ---------------------------------------------------------------------
revoke select on public.users from authenticated;

grant select (
  id, name, username, bio, avatar, cover, work, education,
  "currentCity", hometown, relationship, website, nickname,
  dob, gender, role, "isBot", "botId", status, verified,
  online, "lastSeen", "createdAt", followers, following,
  "closeFriends", settings
) on public.users to authenticated;

-- ---------------------------------------------------------------------
-- 3. botSettings read tightening — STATUS: APPLIED 2026-11-22 (the
--    two statements below were run uncommented in the dashboard and
--    are live; they stay commented here so re-pasting this file does
--    not re-run them).
--    Probe evidence: any signed-in user can read botSettings in full
--    (global kill-switch state + the per-bot daily counters map).
--    Writes are already admin-only (PATCH as Test -> 0 rows, verified).
--    The app reads the 'global' row in every session via sbGet, which
--    returns null when RLS hides the row and the code already
--    tolerates null (the mirror default is enabled:true). Bot cycles
--    and the runner/responder all sign in as admin/superadmin, so
--    restricting reads to admins changes nothing for real users.
-- ---------------------------------------------------------------------
-- drop policy bot_settings_select on public."botSettings";
-- create policy bot_settings_select on public."botSettings"
--   for select to authenticated
--   using (public.is_admin());

-- =====================================================================
-- HOW TO APPLY (dashboard) — ORDER MATTERS:
--   1. PUSH the app fix FIRST (both companion patches above; the
--      column-list patch in src/api.js + runner + responder) and
--      confirm the live site loads profiles/feed normally. The
--      explicit column list is equally valid under the OLD
--      table-level grant, so the pushed app is safe on its own.
--   2. Supabase dashboard -> SQL Editor -> New query -> paste ONLY
--      section 2 (sections 1+3 are already applied; section 1 is
--      idempotent if re-run by accident, section 3 stays commented)
--      -> Run. Expect "Success. No rows returned".
--   3. Verify with the probes below (a normal user must LOSE email
--      access; an admin must keep it via the RPC; the app must still
--      load profiles/feed normally; select=* failing 42501 is
--      EXPECTED — probe with the explicit list).
--
-- VERIFICATION PROBES (curl, publishable key + a NORMAL user token —
-- e.g. MeetBook Test; fill <TEST_JWT> from POST /auth/v1/token):
--   curl -H "apikey: <PUBLISHABLE>" -H "Authorization: Bearer <TEST_JWT>" \
--     "https://ouyuijpxhhvtnxnvavza.supabase.co/rest/v1/users?select=id,username,email&limit=3"
--     -> expect HTTP 403 / "permission denied for column" (was: 200 + emails)
--   curl -H "apikey: <PUBLISHABLE>" -H "Authorization: Bearer <TEST_JWT>" \
--     "https://ouyuijpxhhvtnxnvavza.supabase.co/rest/v1/users?select=id,username,name&limit=3"
--     -> expect HTTP 200 with rows (profiles still work)
--   curl -H "apikey: <PUBLISHABLE>" -H "Authorization: Bearer <TEST_JWT>" \
--     "https://ouyuijpxhhvtnxnvavza.supabase.co/rest/v1/users?select=*&limit=1"
--     -> expect HTTP 403 (42501) — EXPECTED under the lockdown; the
--        app no longer sends select=* on users (explicit list only)
--   As an ADMIN token:
--     POST /rest/v1/rpc/admin_user_emails  -> 200, id+email rows
--   As the TEST token:
--     POST /rest/v1/rpc/admin_user_emails  -> 200, [] (is_admin() gate)
--   If section 3 was applied, as TEST:
--     GET /rest/v1/botSettings?select=*   -> 200, [] (was: full rows)
--
-- ROLLBACK (restores the pre-lockdown state exactly; the app keeps
-- working after a rollback — its explicit column list is valid
-- under the table-level grant too):
--   grant select on public.users to authenticated;
--   drop function if exists public.admin_user_emails();
--   -- and for section 3:
--   -- drop policy bot_settings_select on public."botSettings";
--   -- create policy bot_settings_select on public."botSettings"
--   --   for select to authenticated using (true);
-- =====================================================================
