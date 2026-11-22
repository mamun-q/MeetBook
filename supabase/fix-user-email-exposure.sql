-- =====================================================================
-- fix-user-email-exposure.sql — Security hardening (2026-11-22 audit)
-- STATUS: NOT APPLIED. Apply manually in the Supabase dashboard SQL
-- editor (see steps at the bottom). Nothing in this file has been run
-- against the live project by the audit.
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
--      users column EXCEPT `email`. PostgREST builds its per-role
--      schema cache from these privileges, so `select=*` simply stops
--      returning `email`, and an explicit `select=email` returns
--      HTTP 403 (42501). INSERT/UPDATE privileges are untouched, so
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
-- REQUIRED COMPANION APP PATCH (ship BEFORE or WITH this SQL —
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
-- 3. OPTIONAL (same file, recommended): botSettings read tightening.
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
-- HOW TO APPLY (dashboard)
--   1. Ship the companion app patch (a) + (b) above first, or accept
--      the two documented degradations until it lands.
--   2. Supabase dashboard -> SQL Editor -> New query -> paste this
--      whole file (sections 1+2; section 3 only if wanted) -> Run.
--      Expect "Success. No rows returned".
--   3. Verify with the probes below (a normal user must LOSE email
--      access; an admin must keep it via the RPC; the app must still
--      load profiles/feed normally).
--
-- VERIFICATION PROBES (curl, publishable key + a NORMAL user token —
-- e.g. MeetBook Test; fill <TEST_JWT> from POST /auth/v1/token):
--   curl -H "apikey: <PUBLISHABLE>" -H "Authorization: Bearer <TEST_JWT>" \
--     "https://ouyuijpxhhvtnxnvavza.supabase.co/rest/v1/users?select=id,username,email&limit=3"
--     -> expect HTTP 403 / "permission denied for column" (was: 200 + emails)
--   curl -H "apikey: <PUBLISHABLE>" -H "Authorization: Bearer <TEST_JWT>" \
--     "https://ouyuijpxhhvtnxnvavza.supabase.co/rest/v1/users?select=id,username,name&limit=3"
--     -> expect HTTP 200 with rows (profiles still work)
--   As an ADMIN token:
--     POST /rest/v1/rpc/admin_user_emails  -> 200, id+email rows
--   As the TEST token:
--     POST /rest/v1/rpc/admin_user_emails  -> 200, [] (is_admin() gate)
--   If section 3 was applied, as TEST:
--     GET /rest/v1/botSettings?select=*   -> 200, [] (was: full rows)
--
-- ROLLBACK (restores today's state exactly):
--   grant select on public.users to authenticated;
--   drop function if exists public.admin_user_emails();
--   -- and for section 3:
--   -- drop policy bot_settings_select on public."botSettings";
--   -- create policy bot_settings_select on public."botSettings"
--   --   for select to authenticated using (true);
-- =====================================================================
