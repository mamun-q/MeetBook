-- =====================================================================
-- MeetBook — RLS policies for the Firebase → Supabase migration
-- Phase 1b deliverable. Apply AFTER schema.sql (which creates the
-- tables, the SECURITY DEFINER helper functions and enables RLS on
-- every table — RLS is deliberately NOT re-enabled here).
-- (Fix 2026-11-22, from the first two live runs: five membership
-- tests — posts_insert group check, messages_insert conversation
-- checks, and groups_update_self_membership's old-members checks —
-- compared text against the text[] ROWS of a subquery, which Postgres
-- rejects ("operator does not exist: text = text[]"; ANY over a
-- subquery is always the row form, extra parentheses or not). They
-- are now EXISTS(...) tests against the array's elements.)
--
-- Spec: RLS_NOTES.md. Ground truth: firestore.rules. Every policy
-- block is header-commented with the one-line Firestore guarantee it
-- reproduces.
--
-- ACCESS MODEL
--  The app requires sign-in for everything, so EVERY policy below is
--  `to authenticated` and Firestore's signedIn() is structural, never
--  re-tested per policy. The `anon` role gets no grants in this file
--  and no policy targets `anon` or `public`, so unauthenticated API
--  calls are denied by RLS even where platform default privileges
--  exist. `service_role` bypasses RLS by design (Supabase platform
--  role); the app and the bot runner intentionally never hold it
--  (see RLS_NOTES.md, botActivities/botLogs).
--
-- CONVENTIONS
--  * Caller uid is written `(select auth.uid())::text` throughout
--    (the (select …) form lets the planner initplan it once).
--  * PIN PATTERN (RLS_NOTES.md): Postgres has no OLD↔NEW diff, so
--    WITH CHECK pins a column by comparing the new value against the
--    pre-update row fetched by a self-lookup subquery. Two mechanical
--    notes on the notes' pseudocode:
--      - The correlation is written `o.id = <table>.id` (subquery
--        aliased `o`, outer row qualified by the table name). A bare
--        `id` inside the subquery would bind to the SUBQUERY's own
--        row and make every pin a tautology.
--      - Pins use `is not distinct from` so nullable columns pin
--        correctly (null = null passes, null ≠ value fails).
--    Pins are blacklists: a column added to a pinned table later is
--    writable until it is added to the pin lists (RLS_NOTES.md
--    summary #6 — this file is the checklist for that).
--  * OWNER BRANCHES: where Firestore pins nothing for the owner
--    the policy originally carried an explicit `with check (true)`.
--    Omitting WITH CHECK would silently impose USING on the new row
--    too and narrow the guarantee (e.g. a participant could never
--    remove themselves from a conversation). Role-based branches
--    (admin/moderator/superadmin) repeat their predicate in
--    WITH CHECK instead, which is equivalent and self-documenting.
--    2026-11-25 HARDENING (audit H1/H2/M1–M4): the check(true)
--    owner branches were the audit's main hole — the posts author,
--    stories author, groups/events creator, conversation
--    participant and users self branches now pin the columns the
--    owner must never move (identity, ownership, timestamps) and
--    delta-check the rest to the app's real writes, using the
--    *_row() self-lookups and the jsonb delta helpers below. Pages
--    owner and notifications owner remain check(true) by design
--    (audited, out of that pack's scope).
--  * Subqueries inside policies are themselves RLS-filtered as the
--    caller. Where the caller is guaranteed to pass the referenced
--    table's SELECT policy (the common case) this changes nothing;
--    the exceptions are commented per-table (posts engagement is
--    RLS_NOTES.md summary #5; conversations self-join is a KNOWN
--    ISSUE — see that block).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Grants: supabase-js (PostgREST) needs table privileges for the
-- `authenticated` role before RLS is even consulted. RLS remains the
-- enforcement layer — e.g. "botActivities"/"botLogs" receive the
-- blanket grant below but have NO write policies, so client writes
-- are still denied. No sequences exist (all PKs are text), so no
-- sequence grants are needed. Nothing is granted to `anon`.
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- Keep the same model for tables created by future migrations.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- =====================================================================
-- users
-- Guarantee: any signed-in user reads all profiles; self-register
-- only as role='user', isBot=false, and only while registration is
-- open — or an admin creating a bot profile (isBot=true, role='bot');
-- updates by self/admin with role+isBot pinned and (2026-11-25, H1)
-- status/verified movable only by an admin on someone else's row,
-- followers/botId/createdAt/email pinned (superadmin unpinned),
-- plus a followers-only branch where anyone may add/remove exactly
-- their own uid; delete by self or admin.
-- (Carried-over exposure, mirrored 1:1: email/status are readable by
-- every signed-in user, exactly as in Firestore — see RLS_NOTES.md.)
-- =====================================================================
-- =====================================================================
-- RLS recursion fix (2026-11-22): SECURITY DEFINER row fetchers.
-- UPDATE policies must never subquery their own table (Postgres
-- aborts with "infinite recursion detected in policy"); they read
-- the stored row through these helpers instead, which bypass RLS.
-- =====================================================================
create or replace function public."conversations_row"(p_id text)
returns public."conversations"
language sql security definer set search_path = public stable as $$
  select t from public."conversations" t where t.id = p_id
$$;
revoke execute on function public."conversations_row"(text) from public, anon;
grant execute on function public."conversations_row"(text) to authenticated;

create or replace function public."events_row"(p_id text)
returns public."events"
language sql security definer set search_path = public stable as $$
  select t from public."events" t where t.id = p_id
$$;
revoke execute on function public."events_row"(text) from public, anon;
grant execute on function public."events_row"(text) to authenticated;

create or replace function public."friendships_row"(p_id text)
returns public."friendships"
language sql security definer set search_path = public stable as $$
  select t from public."friendships" t where t.id = p_id
$$;
revoke execute on function public."friendships_row"(text) from public, anon;
grant execute on function public."friendships_row"(text) to authenticated;

create or replace function public."groupRequests_row"(p_id text)
returns public."groupRequests"
language sql security definer set search_path = public stable as $$
  select t from public."groupRequests" t where t.id = p_id
$$;
revoke execute on function public."groupRequests_row"(text) from public, anon;
grant execute on function public."groupRequests_row"(text) to authenticated;

create or replace function public."groups_row"(p_id text)
returns public."groups"
language sql security definer set search_path = public stable as $$
  select t from public."groups" t where t.id = p_id
$$;
revoke execute on function public."groups_row"(text) from public, anon;
grant execute on function public."groups_row"(text) to authenticated;

create or replace function public."messages_row"(p_id text)
returns public."messages"
language sql security definer set search_path = public stable as $$
  select t from public."messages" t where t.id = p_id
$$;
revoke execute on function public."messages_row"(text) from public, anon;
grant execute on function public."messages_row"(text) to authenticated;

create or replace function public."pages_row"(p_id text)
returns public."pages"
language sql security definer set search_path = public stable as $$
  select t from public."pages" t where t.id = p_id
$$;
revoke execute on function public."pages_row"(text) from public, anon;
grant execute on function public."pages_row"(text) to authenticated;

create or replace function public."posts_row"(p_id text)
returns public."posts"
language sql security definer set search_path = public stable as $$
  select t from public."posts" t where t.id = p_id
$$;
revoke execute on function public."posts_row"(text) from public, anon;
grant execute on function public."posts_row"(text) to authenticated;

create or replace function public."reviews_row"(p_id text)
returns public."reviews"
language sql security definer set search_path = public stable as $$
  select t from public."reviews" t where t.id = p_id
$$;
revoke execute on function public."reviews_row"(text) from public, anon;
grant execute on function public."reviews_row"(text) to authenticated;

create or replace function public."stories_row"(p_id text)
returns public."stories"
language sql security definer set search_path = public stable as $$
  select t from public."stories" t where t.id = p_id
$$;
revoke execute on function public."stories_row"(text) from public, anon;
grant execute on function public."stories_row"(text) to authenticated;

create or replace function public."users_row"(p_id text)
returns public."users"
language sql security definer set search_path = public stable as $$
  select t from public."users" t where t.id = p_id
$$;
revoke execute on function public."users_row"(text) from public, anon;
grant execute on function public."users_row"(text) to authenticated;

-- ---------------------------------------------------------------------
-- Engagement delta helpers (2026-11-25 audit fix pack, H2/M2/M3/M4).
-- Pure jsonb transforms (no table access, so plain immutable — not
-- security definer): they express "this jsonb value may only move by
-- the caller's own uid" for the whole-value array/object writes the
-- app performs. The followers/story-views policies spell the ±uid
-- delta out inline; these helpers give the posts/conversations/
-- messages/events branches the same guarantee for their richer
-- shapes (reactions maps, poll votes, nested comment replies).
-- ---------------------------------------------------------------------
create or replace function public.jsonb_uid_count(p_list jsonb, p_uid text)
returns integer
language sql immutable set search_path = public as $$
  select coalesce((
    select count(*)::integer
    from jsonb_array_elements(coalesce(p_list, '[]'::jsonb)) e
    where e = to_jsonb(p_uid)), 0)
$$;
revoke execute on function public.jsonb_uid_count(jsonb, text) from public, anon;
grant execute on function public.jsonb_uid_count(jsonb, text) to authenticated;

-- The list with every occurrence of p_uid removed, order preserved.
create or replace function public.jsonb_list_without_uid(p_list jsonb, p_uid text)
returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_agg(e order by ord)
    from jsonb_array_elements(coalesce(p_list, '[]'::jsonb))
           with ordinality as t(e, ord)
    where e <> to_jsonb(p_uid)), '[]'::jsonb)
$$;
revoke execute on function public.jsonb_list_without_uid(jsonb, text) from public, anon;
grant execute on function public.jsonb_list_without_uid(jsonb, text) to authenticated;

-- True when new = old, or new differs from old ONLY by the caller's
-- uid appearing once more or once fewer (a like/save/RSVP toggle).
create or replace function public.uid_list_delta_ok(p_old jsonb, p_new jsonb, p_uid text)
returns boolean
language sql immutable set search_path = public as $$
  select public.jsonb_list_without_uid(p_old, p_uid)
           = public.jsonb_list_without_uid(p_new, p_uid)
    and abs(public.jsonb_uid_count(p_new, p_uid)
            - public.jsonb_uid_count(p_old, p_uid)) <= 1
$$;
revoke execute on function public.uid_list_delta_ok(jsonb, jsonb, text) from public, anon;
grant execute on function public.uid_list_delta_ok(jsonb, jsonb, text) to authenticated;

-- True when new differs from old only by INSERTIONS of the caller's
-- uid (at most one) — read receipts (readBy) and remove-for-me
-- (hiddenFor) only ever grow by the reader's own uid.
create or replace function public.uid_list_add_ok(p_old jsonb, p_new jsonb, p_uid text)
returns boolean
language sql immutable set search_path = public as $$
  select public.jsonb_list_without_uid(p_old, p_uid)
           = public.jsonb_list_without_uid(p_new, p_uid)
    and public.jsonb_uid_count(p_new, p_uid)
          - public.jsonb_uid_count(p_old, p_uid) between 0 and 1
    and jsonb_array_length(coalesce(p_new, '[]'::jsonb))
          - jsonb_array_length(coalesce(p_old, '[]'::jsonb))
          = public.jsonb_uid_count(p_new, p_uid)
            - public.jsonb_uid_count(p_old, p_uid)
$$;
revoke execute on function public.uid_list_add_ok(jsonb, jsonb, text) from public, anon;
grant execute on function public.uid_list_add_ok(jsonb, jsonb, text) to authenticated;

-- For { uid: value } maps (post reactions, poll votes): true when
-- the two maps agree everywhere except possibly at the caller's key.
create or replace function public.uid_map_delta_ok(p_old jsonb, p_new jsonb, p_uid text)
returns boolean
language sql immutable set search_path = public as $$
  select (coalesce(p_new, '{}'::jsonb) - p_uid)
           = (coalesce(p_old, '{}'::jsonb) - p_uid)
$$;
revoke execute on function public.uid_map_delta_ok(jsonb, jsonb, text) from public, anon;
grant execute on function public.uid_map_delta_ok(jsonb, jsonb, text) to authenticated;

-- Post polls { options, votes: { uid: optionId } }: options (and any
-- other key) identical; votes move only at the caller's key.
create or replace function public.post_poll_delta_ok(p_old jsonb, p_new jsonb, p_uid text)
returns boolean
language sql immutable set search_path = public as $$
  select (p_old is null and p_new is null)
    or (
      p_old is not null and p_new is not null
      and (p_new - 'votes') = (p_old - 'votes')
      and public.uid_map_delta_ok(p_old->'votes', p_new->'votes', p_uid)
    )
$$;
revoke execute on function public.post_poll_delta_ok(jsonb, jsonb, text) from public, anon;
grant execute on function public.post_poll_delta_ok(jsonb, jsonb, text) to authenticated;

-- Chat polls { options: [{ id, text, votes: [uid] }] }: the poll
-- with the caller's votes stripped from every option — two polls
-- whose stripped forms are equal differ only in the caller's votes.
create or replace function public.chat_poll_without_voter(p_poll jsonb, p_uid text)
returns jsonb
language sql immutable set search_path = public as $$
  select case when p_poll is null then null
    else jsonb_set(p_poll, '{options}', coalesce((
      select jsonb_agg(
               jsonb_set(o, '{votes}',
                 public.jsonb_list_without_uid(o->'votes', p_uid))
               order by ord)
      from jsonb_array_elements(coalesce(p_poll->'options', '[]'::jsonb))
             with ordinality as t(o, ord)), '[]'::jsonb))
  end
$$;
revoke execute on function public.chat_poll_without_voter(jsonb, text) from public, anon;
grant execute on function public.chat_poll_without_voter(jsonb, text) to authenticated;

create or replace function public.chat_poll_delta_ok(p_old jsonb, p_new jsonb, p_uid text)
returns boolean
language sql immutable set search_path = public as $$
  select (p_old is null and p_new is null)
    or (
      p_old is not null and p_new is not null
      and public.chat_poll_without_voter(p_old, p_uid)
            = public.chat_poll_without_voter(p_new, p_uid)
      and (select count(*)
           from jsonb_array_elements(coalesce(p_new->'options', '[]'::jsonb)) o,
                jsonb_array_elements(coalesce(o->'votes', '[]'::jsonb)) v
           where v = to_jsonb(p_uid)) <= 1
    )
$$;
revoke execute on function public.chat_poll_delta_ok(jsonb, jsonb, text) from public, anon;
grant execute on function public.chat_poll_delta_ok(jsonb, jsonb, text) to authenticated;

-- Message reactions { emoji: [uid] }: the map with the caller
-- stripped from every list (empty lists dropped) — equal stripped
-- forms mean only the caller's own reactions moved.
create or replace function public.msg_reactions_without_user(p_r jsonb, p_uid text)
returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((
    select jsonb_object_agg(k, stripped)
    from (
      select e.key as k,
             public.jsonb_list_without_uid(e.value, p_uid) as stripped
      from jsonb_each(coalesce(p_r, '{}'::jsonb)) e
    ) s
    where jsonb_array_length(stripped) > 0), '{}'::jsonb)
$$;
revoke execute on function public.msg_reactions_without_user(jsonb, text) from public, anon;
grant execute on function public.msg_reactions_without_user(jsonb, text) to authenticated;

create or replace function public.msg_reactions_delta_ok(p_old jsonb, p_new jsonb, p_uid text)
returns boolean
language sql immutable set search_path = public as $$
  select public.msg_reactions_without_user(p_old, p_uid)
           = public.msg_reactions_without_user(p_new, p_uid)
$$;
revoke execute on function public.msg_reactions_delta_ok(jsonb, jsonb, text) from public, anon;
grant execute on function public.msg_reactions_delta_ok(jsonb, jsonb, text) to authenticated;

-- One comment element whose `replies` moved legally: every field
-- except replies identical, and the replies delta is exactly one
-- append authored by the caller, or exactly one removal whose
-- author is the caller or the post author (the UI's delete rule:
-- comment/reply author or post author).
create or replace function public.replies_delta_ok(p_old_el jsonb, p_new_el jsonb, p_uid text, p_post_author text)
returns boolean
language sql immutable set search_path = public as $$
  select (p_new_el - 'replies') = (p_old_el - 'replies')
    and (
      ( -- append one reply authored by the caller
        jsonb_array_length(coalesce(p_new_el->'replies', '[]'::jsonb))
          = jsonb_array_length(coalesce(p_old_el->'replies', '[]'::jsonb)) + 1
        and not exists (
          select 1
          from jsonb_array_elements(coalesce(p_old_el->'replies', '[]'::jsonb)) r
          where not exists (
            select 1
            from jsonb_array_elements(coalesce(p_new_el->'replies', '[]'::jsonb)) r2
            where r2 = r))
        and exists (
          select 1
          from jsonb_array_elements(coalesce(p_new_el->'replies', '[]'::jsonb)) r
          where (r->>'authorId') = p_uid
            and not exists (
              select 1
              from jsonb_array_elements(coalesce(p_old_el->'replies', '[]'::jsonb)) r2
              where (r2->>'id') = (r->>'id')))
      )
      or
      ( -- remove one reply (its author, or the post author)
        jsonb_array_length(coalesce(p_new_el->'replies', '[]'::jsonb))
          = jsonb_array_length(coalesce(p_old_el->'replies', '[]'::jsonb)) - 1
        and not exists (
          select 1
          from jsonb_array_elements(coalesce(p_new_el->'replies', '[]'::jsonb)) r
          where not exists (
            select 1
            from jsonb_array_elements(coalesce(p_old_el->'replies', '[]'::jsonb)) r2
            where r2 = r))
        and exists (
          select 1
          from jsonb_array_elements(coalesce(p_old_el->'replies', '[]'::jsonb)) r
          where ((r->>'authorId') = p_uid or p_post_author = p_uid)
            and not exists (
              select 1
              from jsonb_array_elements(coalesce(p_new_el->'replies', '[]'::jsonb)) r2
              where (r2->>'id') = (r->>'id')))
      )
    )
$$;
revoke execute on function public.replies_delta_ok(jsonb, jsonb, text, text) from public, anon;
grant execute on function public.replies_delta_ok(jsonb, jsonb, text, text) to authenticated;

-- A post's whole comments array may only move by ONE of the app's
-- comment writes: append one top-level comment authored by the
-- caller (with no pre-filled replies), delete one top-level comment
-- (its author or the post author), or change exactly one comment's
-- replies by a legal replies delta. Anything else — wiping the
-- array, editing or deleting other people's comments, forging
-- authorship — fails.
create or replace function public.comments_delta_ok(p_old jsonb, p_new jsonb, p_uid text, p_post_author text)
returns boolean
language sql immutable set search_path = public as $$
  with o_el as (
    select e from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) e),
  n_el as (
    select e from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) e),
  added as (
    select e from n_el
    where not exists (
      select 1 from o_el where (o_el.e->>'id') = (n_el.e->>'id'))),
  removed as (
    select e from o_el
    where not exists (
      select 1 from n_el where (n_el.e->>'id') = (o_el.e->>'id'))),
  changed as (
    select o_el.e as oe, n_el.e as ne
    from o_el join n_el on (n_el.e->>'id') = (o_el.e->>'id')
    where n_el.e is distinct from o_el.e)
  select
    (select count(*) from added) = 0
      and (select count(*) from removed) = 0
      and (select count(*) from changed) = 0
    or (
      (select count(*) from added) = 1
      and (select count(*) from removed) = 0
      and (select count(*) from changed) = 0
      and (select bool_and((e->>'authorId') = p_uid
                           and coalesce(e->'replies', '[]'::jsonb) = '[]'::jsonb)
             from added)
    )
    or (
      (select count(*) from removed) = 1
      and (select count(*) from added) = 0
      and (select count(*) from changed) = 0
      and (select bool_and((e->>'authorId') = p_uid or p_post_author = p_uid)
             from removed)
    )
    or (
      (select count(*) from changed) = 1
      and (select count(*) from added) = 0
      and (select count(*) from removed) = 0
      and (select bool_and(public.replies_delta_ok(oe, ne, p_uid, p_post_author))
             from changed)
    )
$$;
revoke execute on function public.comments_delta_ok(jsonb, jsonb, text, text) from public, anon;
grant execute on function public.comments_delta_ok(jsonb, jsonb, text, text) to authenticated;

create policy users_select_all on public.users
  for select to authenticated
  using (true);

create policy users_insert_self on public.users
  for insert to authenticated
  with check (
    id = (select auth.uid())::text
    and role = 'user'
    and not "isBot"
    and public.registration_open()
  );

create policy users_insert_admin_bot on public.users
  for insert to authenticated
  with check (
    public.is_admin()
    and "isBot"
    and role = 'bot'
  );

create policy users_update_superadmin on public.users
  for update to authenticated
  using (public.is_superadmin())
  with check (public.is_superadmin());

create policy users_update_self_admin on public.users
  for update to authenticated
  using (id = (select auth.uid())::text or public.is_admin())
  with check (
    (id = (select auth.uid())::text or public.is_admin())
    and role is not distinct from
          ((public."users_row"(users.id)).role)
    and "isBot" is not distinct from
          ((public."users_row"(users.id))."isBot")
    -- 2026-11-25 audit H1: status/verified/followers/botId/
    -- createdAt/email were writable through this branch — a banned
    -- user could PATCH their own row back to status='active'
    -- (voiding writer_status_ok() everywhere) and anyone could
    -- self-grant verified=true. status/verified now move only when
    -- an admin changes SOMEONE ELSE's row (the app's
    -- adminSetUserStatus/adminSetVerified are admin-only and refuse
    -- self-management — utils.canManageUser; superadmins keep the
    -- unpinned branch above). followers move only through
    -- users_update_followers (± caller uid); botId/createdAt/email
    -- never move after insert.
    and (
      status is not distinct from
        ((public."users_row"(users.id)).status)
      or (public.is_admin() and id <> (select auth.uid())::text)
    )
    and (
      verified is not distinct from
        ((public."users_row"(users.id)).verified)
      or (public.is_admin() and id <> (select auth.uid())::text)
    )
    and followers is not distinct from
          ((public."users_row"(users.id)).followers)
    and "botId" is not distinct from
          ((public."users_row"(users.id))."botId")
    and "createdAt" is not distinct from
          ((public."users_row"(users.id))."createdAt")
    and email is not distinct from
          ((public."users_row"(users.id)).email)
  );

-- Followers-only branch: every column except `followers` pinned via
-- self-lookup; the followers delta is exactly + or − the caller's uid
-- (length ±1, containment both ways, caller-membership flips).
create policy users_update_followers on public.users
  for update to authenticated
  using (id <> (select auth.uid())::text)
  with check (
    name is not distinct from
      ((public."users_row"(users.id)).name)
    and username is not distinct from
      ((public."users_row"(users.id)).username)
    and email is not distinct from
      ((public."users_row"(users.id)).email)
    and bio is not distinct from
      ((public."users_row"(users.id)).bio)
    and avatar is not distinct from
      ((public."users_row"(users.id)).avatar)
    and cover is not distinct from
      ((public."users_row"(users.id)).cover)
    and work is not distinct from
      ((public."users_row"(users.id)).work)
    and education is not distinct from
      ((public."users_row"(users.id)).education)
    and "currentCity" is not distinct from
      ((public."users_row"(users.id))."currentCity")
    and hometown is not distinct from
      ((public."users_row"(users.id)).hometown)
    and relationship is not distinct from
      ((public."users_row"(users.id)).relationship)
    and website is not distinct from
      ((public."users_row"(users.id)).website)
    and nickname is not distinct from
      ((public."users_row"(users.id)).nickname)
    and dob is not distinct from
      ((public."users_row"(users.id)).dob)
    and gender is not distinct from
      ((public."users_row"(users.id)).gender)
    and role is not distinct from
      ((public."users_row"(users.id)).role)
    and "isBot" is not distinct from
      ((public."users_row"(users.id))."isBot")
    and "botId" is not distinct from
      ((public."users_row"(users.id))."botId")
    and status is not distinct from
      ((public."users_row"(users.id)).status)
    and verified is not distinct from
      ((public."users_row"(users.id)).verified)
    and online is not distinct from
      ((public."users_row"(users.id)).online)
    and "lastSeen" is not distinct from
      ((public."users_row"(users.id))."lastSeen")
    and "createdAt" is not distinct from
      ((public."users_row"(users.id))."createdAt")
    and following is not distinct from
      ((public."users_row"(users.id)).following)
    and "closeFriends" is not distinct from
      ((public."users_row"(users.id))."closeFriends")
    and settings is not distinct from
      ((public."users_row"(users.id)).settings)
    and (
      ( -- follow: append exactly the caller's uid
        jsonb_array_length(followers)
          = jsonb_array_length(((public."users_row"(users.id)).followers)) + 1
        and followers @> ((public."users_row"(users.id)).followers)
        and followers @> jsonb_build_array((select auth.uid())::text)
        and not (((public."users_row"(users.id)).followers)
                 @> jsonb_build_array((select auth.uid())::text))
      )
      or
      ( -- unfollow: remove exactly the caller's uid
        jsonb_array_length(followers)
          = jsonb_array_length(((public."users_row"(users.id)).followers)) - 1
        and ((public."users_row"(users.id)).followers) @> followers
        and ((public."users_row"(users.id)).followers)
              @> jsonb_build_array((select auth.uid())::text)
        and not (followers @> jsonb_build_array((select auth.uid())::text))
      )
    )
  );

create policy users_delete_self_admin on public.users
  for delete to authenticated
  using (id = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- posts
-- Guarantee: read by author, admins, anyone if visibility='public',
-- uid ∈ audienceIds for NON-group posts, or — for group posts — by
-- the group's CURRENT membership evaluated at read time (non-private
-- group: any signed-in user; private group: current members or the
-- creator). A group post's stored audienceIds (the member list at
-- creation time) never grants reads: the snapshot goes stale in both
-- directions — it hid older posts from later joiners and kept
-- showing them to former members. Create by an active writer with
-- likes empty, as self (group posts only if a member of that group),
-- or by an admin as a bot (plain feed only — no group/page posts);
-- update by admin, by the author (text/editedAt only — 2026-11-25
-- M1), or by any signed-in user with every content column pinned
-- and every engagement column delta-checked to ± the caller's own
-- uid (2026-11-25 H2); delete by author or admin.
-- =====================================================================
create policy posts_select on public.posts
  for select to authenticated
  using (
    "authorId" = (select auth.uid())::text
    or public.is_admin()
    or visibility = 'public'
    or (
      "groupId" = ''
      and (select auth.uid())::text = any ("audienceIds")
    )
    or (
      "groupId" <> ''
      and exists (
        select 1 from public.groups g
        where g.id = posts."groupId"
          and (
            g.privacy <> 'private'
            or (select auth.uid())::text = any (g.members)
            or g."createdBy" = (select auth.uid())::text
          )
      )
    )
  );

create policy posts_insert on public.posts
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and likes = '[]'::jsonb
    and (
      (
        "authorId" = (select auth.uid())::text
        and (
          "groupId" = ''
          or exists (
               select 1 from public.groups g
               where g.id = "groupId"
                 and (select auth.uid())::text = any (g.members))
        )
      )
      or (
        public.is_admin()
        and public.is_bot_user("authorId")
        and "groupId" = ''
        and "pageId" = ''
      )
    )
  );

create policy posts_update_admin on public.posts
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Author branch. 2026-11-25 audit M1: this was `with check (true)`
-- (the old header convention) — the author could rewrite authorId
-- (impersonation), createdAt, group/page placement and pre-load
-- engagement on their own post. The author's only content write in
-- the app is editPost ({text, editedAt}), so everything else is now
-- pinned to the stored row. Engagement on the author's own post is
-- unaffected: it rides posts_update_engagement below.
create policy posts_update_author on public.posts
  for update to authenticated
  using ("authorId" = (select auth.uid())::text)
  with check (
    "authorId" = (select auth.uid())::text
    and image is not distinct from
      ((public."posts_row"(posts.id)).image)
    and visibility is not distinct from
      ((public."posts_row"(posts.id)).visibility)
    and "audienceIds" is not distinct from
      ((public."posts_row"(posts.id))."audienceIds")
    and "createdAt" is not distinct from
      ((public."posts_row"(posts.id))."createdAt")
    and likes is not distinct from
      ((public."posts_row"(posts.id)).likes)
    and reactions is not distinct from
      ((public."posts_row"(posts.id)).reactions)
    and comments is not distinct from
      ((public."posts_row"(posts.id)).comments)
    and shares is not distinct from
      ((public."posts_row"(posts.id)).shares)
    and "sharedFrom" is not distinct from
      ((public."posts_row"(posts.id))."sharedFrom")
    and "savedBy" is not distinct from
      ((public."posts_row"(posts.id))."savedBy")
    and "groupId" is not distinct from
      ((public."posts_row"(posts.id))."groupId")
    and "pageId" is not distinct from
      ((public."posts_row"(posts.id))."pageId")
    and "pageName" is not distinct from
      ((public."posts_row"(posts.id))."pageName")
    and "pageAvatar" is not distinct from
      ((public."posts_row"(posts.id))."pageAvatar")
    and poll is not distinct from
      ((public."posts_row"(posts.id)).poll)
    and location is not distinct from
      ((public."posts_row"(posts.id)).location)
    and feeling is not distinct from
      ((public."posts_row"(posts.id)).feeling)
    and pinned is not distinct from
      ((public."posts_row"(posts.id)).pinned)
  );

-- Engagement branch. NOTE (RLS_NOTES.md summary #5): the pin
-- self-lookups are filtered by posts_select, so engagement
-- effectively requires the post to be readable by the caller —
-- Firestore allowed engaging with an unreadable post by id. Safe
-- direction; no real flow changes (clients engage with loaded posts).
-- 2026-11-25 audit H2: the engagement columns themselves were
-- unpinned — any signed-in user could wipe a post's comments,
-- forge like counts, rewrite poll votes or pin/unpin at will.
-- Every engagement column now carries a ±-caller delta check (the
-- helpers above), shaped to exactly the writes src/api.js performs:
-- likes/savedBy ± own uid; reactions move only at the caller's key;
-- poll votes only at the caller's key with options identical;
-- shares +1 at most; pinned only by the post's group creator
-- (togglePinPost); comments by the single-comment deltas in
-- comments_delta_ok (append own / delete own-or-post-author's /
-- one reply delta).
create policy posts_update_engagement on public.posts
  for update to authenticated
  using (true)
  with check (
    "authorId" is not distinct from
      ((public."posts_row"(posts.id))."authorId")
    and text is not distinct from
      ((public."posts_row"(posts.id)).text)
    and image is not distinct from
      ((public."posts_row"(posts.id)).image)
    and visibility is not distinct from
      ((public."posts_row"(posts.id)).visibility)
    and "groupId" is not distinct from
      ((public."posts_row"(posts.id))."groupId")
    and "pageId" is not distinct from
      ((public."posts_row"(posts.id))."pageId")
    and "audienceIds" is not distinct from
      ((public."posts_row"(posts.id))."audienceIds")
    and "pageName" is not distinct from
      ((public."posts_row"(posts.id))."pageName")
    and "pageAvatar" is not distinct from
      ((public."posts_row"(posts.id))."pageAvatar")
    and "sharedFrom" is not distinct from
      ((public."posts_row"(posts.id))."sharedFrom")
    and location is not distinct from
      ((public."posts_row"(posts.id)).location)
    and feeling is not distinct from
      ((public."posts_row"(posts.id)).feeling)
    and "createdAt" is not distinct from
      ((public."posts_row"(posts.id))."createdAt")
    and "editedAt" is not distinct from
      ((public."posts_row"(posts.id))."editedAt")
    and public.uid_list_delta_ok(
          ((public."posts_row"(posts.id)).likes), likes,
          (select auth.uid())::text)
    and public.uid_list_delta_ok(
          ((public."posts_row"(posts.id))."savedBy"), "savedBy",
          (select auth.uid())::text)
    and public.uid_map_delta_ok(
          ((public."posts_row"(posts.id)).reactions), reactions,
          (select auth.uid())::text)
    and public.post_poll_delta_ok(
          ((public."posts_row"(posts.id)).poll), poll,
          (select auth.uid())::text)
    and (
      shares = ((public."posts_row"(posts.id)).shares)
      or shares = ((public."posts_row"(posts.id)).shares) + 1
    )
    and (
      pinned is not distinct from
        ((public."posts_row"(posts.id)).pinned)
      or exists (
        select 1 from public.groups g
        where g.id = ((public."posts_row"(posts.id))."groupId")
          and g."createdBy" = (select auth.uid())::text
      )
    )
    and public.comments_delta_ok(
          ((public."posts_row"(posts.id)).comments), comments,
          (select auth.uid())::text,
          ((public."posts_row"(posts.id))."authorId"))
  );

create policy posts_delete on public.posts
  for delete to authenticated
  using ("authorId" = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- stories
-- Guarantee: posts-shaped reads; create as self, active writer,
-- views empty; update by author/admin, or any signed-in user
-- appending exactly their own uid to views and nothing else; delete
-- by author/admin.
-- =====================================================================
create policy stories_select on public.stories
  for select to authenticated
  using (
    "authorId" = (select auth.uid())::text
    or public.is_admin()
    or visibility = 'public'
    or (select auth.uid())::text = any ("audienceIds")
  );

create policy stories_insert on public.stories
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "authorId" = (select auth.uid())::text
    and views = '[]'::jsonb
  );

-- 2026-11-25 audit M1 (sibling of posts_update_author): was
-- `with check (true)` — an author could fabricate their own story
-- views or rewrite authorId. The app has NO story content-edit
-- flow (create / view / delete only; views move through
-- stories_update_views below), so every column is pinned here and
-- this branch passes only no-op writes.
create policy stories_update_author_admin on public.stories
  for update to authenticated
  using ("authorId" = (select auth.uid())::text or public.is_admin())
  with check (
    ("authorId" = (select auth.uid())::text or public.is_admin())
    and "authorId" is not distinct from
      ((public."stories_row"(stories.id))."authorId")
    and image is not distinct from
      ((public."stories_row"(stories.id)).image)
    and text is not distinct from
      ((public."stories_row"(stories.id)).text)
    and bg is not distinct from
      ((public."stories_row"(stories.id)).bg)
    and visibility is not distinct from
      ((public."stories_row"(stories.id)).visibility)
    and "audienceIds" is not distinct from
      ((public."stories_row"(stories.id))."audienceIds")
    and views is not distinct from
      ((public."stories_row"(stories.id)).views)
    and "createdAt" is not distinct from
      ((public."stories_row"(stories.id))."createdAt")
  );

-- Views-append branch: every column except `views` pinned; the views
-- delta is exactly + the caller's uid (same jsonb construction as
-- users_update_followers). The pin self-lookups are filtered by
-- stories_select, so — as with posts engagement (summary #5) — the
-- caller must be able to read the story; the client only marks views
-- on stories it has loaded, so no real flow changes.
create policy stories_update_views on public.stories
  for update to authenticated
  using (true)
  with check (
    "authorId" is not distinct from
      ((public."stories_row"(stories.id))."authorId")
    and image is not distinct from
      ((public."stories_row"(stories.id)).image)
    and text is not distinct from
      ((public."stories_row"(stories.id)).text)
    and bg is not distinct from
      ((public."stories_row"(stories.id)).bg)
    and visibility is not distinct from
      ((public."stories_row"(stories.id)).visibility)
    and "audienceIds" is not distinct from
      ((public."stories_row"(stories.id))."audienceIds")
    and "createdAt" is not distinct from
      ((public."stories_row"(stories.id))."createdAt")
    and jsonb_array_length(views)
          = jsonb_array_length(((public."stories_row"(stories.id)).views)) + 1
    and views @> ((public."stories_row"(stories.id)).views)
    and views @> jsonb_build_array((select auth.uid())::text)
    and not (((public."stories_row"(stories.id)).views)
             @> jsonb_build_array((select auth.uid())::text))
  );

create policy stories_delete on public.stories
  for delete to authenticated
  using ("authorId" = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- groups
-- Guarantee: public groups readable by all signed-in; private only
-- by members/creator/admins; create as self with creator ∈ members;
-- update by admin/creator, or a members-only update where a
-- non-creator adds/removes exactly themselves; delete by creator or
-- admin.
-- =====================================================================
create policy groups_select on public.groups
  for select to authenticated
  using (
    privacy = 'public'
    or (select auth.uid())::text = any (members)
    or "createdBy" = (select auth.uid())::text
    or public.is_admin()
  );

create policy groups_insert on public.groups
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "createdBy" = (select auth.uid())::text
    and (select auth.uid())::text = any (members)
  );

-- 2026-11-25 audit M1 (sibling of posts_update_author): was
-- `with check (true)` — a group creator could rewrite createdBy
-- (transferring ownership) or the whole members list. createdBy/
-- createdAt are now pinned for everyone on this branch; content
-- fields stay free for admin/creator (updateGroup); members move
-- freely for admins, and for the creator only by the exact deltas
-- the app performs: +1 (respondGroupRequest approve) or −1, never
-- the creator themselves (removeGroupMember). Ordinary join/leave
-- rides groups_update_self_membership below.
create policy groups_update_admin_creator on public.groups
  for update to authenticated
  using (public.is_admin() or "createdBy" = (select auth.uid())::text)
  with check (
    (public.is_admin() or "createdBy" = (select auth.uid())::text)
    and "createdBy" is not distinct from
      ((public."groups_row"(groups.id))."createdBy")
    and "createdAt" is not distinct from
      ((public."groups_row"(groups.id))."createdAt")
    and (
      public.is_admin()
      or members is not distinct from
        ((public."groups_row"(groups.id)).members)
      or (
        cardinality(members)
          = cardinality(((public."groups_row"(groups.id)).members)) + 1
        and members @> ((public."groups_row"(groups.id)).members)
      )
      or (
        cardinality(members)
          = cardinality(((public."groups_row"(groups.id)).members)) - 1
        and ((public."groups_row"(groups.id)).members) @> members
        and not exists (
          select 1
          from unnest(((public."groups_row"(groups.id)).members)) x
          where x <> all (members)
            and x = ((public."groups_row"(groups.id))."createdBy"))
      )
    )
  );

-- Self-membership branch: `members` is text[], so the ±self check is
-- exact — cardinality ±1, superset one way, and the caller's
-- membership flips. Every other column pinned via self-lookup.
-- Note: the self-lookups are filtered by groups_select, so this
-- branch effectively covers public groups (and groups the caller
-- already belongs to). Private-group joins in the app go through
-- groupRequests, not this branch, so no real flow changes.
create policy groups_update_self_membership on public.groups
  for update to authenticated
  using (true)
  with check (
    name is not distinct from
      ((public."groups_row"(groups.id)).name)
    and description is not distinct from
      ((public."groups_row"(groups.id)).description)
    and privacy is not distinct from
      ((public."groups_row"(groups.id)).privacy)
    and cover is not distinct from
      ((public."groups_row"(groups.id)).cover)
    and "createdBy" is not distinct from
      ((public."groups_row"(groups.id))."createdBy")
    and "createdAt" is not distinct from
      ((public."groups_row"(groups.id))."createdAt")
    and (
      ( -- join: add exactly the caller's uid
        cardinality(members)
          = cardinality(((public."groups_row"(groups.id)).members)) + 1
        and members @> ((public."groups_row"(groups.id)).members)
        and (select auth.uid())::text = any (members)
        and not ((select auth.uid())::text = any (((public."groups_row"(groups.id)).members)))
      )
      or
      ( -- leave: remove exactly the caller's uid
        cardinality(members)
          = cardinality(((public."groups_row"(groups.id)).members)) - 1
        and ((public."groups_row"(groups.id)).members) @> members
        and ((select auth.uid())::text = any (((public."groups_row"(groups.id)).members)))
        and not ((select auth.uid())::text = any (members))
      )
    )
  );

create policy groups_delete on public.groups
  for delete to authenticated
  using ("createdBy" = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- groupRequests
-- Guarantee: read by the requester, the group owner (denormalised
-- groupOwnerId), or admins; create as self with status='pending';
-- update by owner/admin with userId/groupId/groupOwnerId pinned
-- (only status moves); delete by requester/owner/admin.
-- =====================================================================
create policy group_requests_select on public."groupRequests"
  for select to authenticated
  using (
    "userId" = (select auth.uid())::text
    or "groupOwnerId" = (select auth.uid())::text
    or public.is_admin()
  );

create policy group_requests_insert on public."groupRequests"
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "userId" = (select auth.uid())::text
    and status = 'pending'
  );

create policy group_requests_update on public."groupRequests"
  for update to authenticated
  using ("groupOwnerId" = (select auth.uid())::text or public.is_admin())
  with check (
    ("groupOwnerId" = (select auth.uid())::text or public.is_admin())
    and "userId" is not distinct from
      ((public."groupRequests_row"("groupRequests".id))."userId")
    and "groupId" is not distinct from
      ((public."groupRequests_row"("groupRequests".id))."groupId")
    and "groupOwnerId" is not distinct from
      ((public."groupRequests_row"("groupRequests".id))."groupOwnerId")
  );

create policy group_requests_delete on public."groupRequests"
  for delete to authenticated
  using (
    "userId" = (select auth.uid())::text
    or "groupOwnerId" = (select auth.uid())::text
    or public.is_admin()
  );

-- =====================================================================
-- pages
-- Guarantee: read by all signed-in; create as owner (active writer);
-- update by admin/owner, or a followers-only ±own-uid update by
-- anyone else; delete by owner/admin.
-- =====================================================================
create policy pages_select on public.pages
  for select to authenticated
  using (true);

create policy pages_insert on public.pages
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "ownerId" = (select auth.uid())::text
  );

create policy pages_update_admin_owner on public.pages
  for update to authenticated
  using (public.is_admin() or "ownerId" = (select auth.uid())::text)
  with check (true);

-- Followers-only branch: same jsonb ±caller construction as
-- users_update_followers; every other column pinned via self-lookup.
create policy pages_update_followers on public.pages
  for update to authenticated
  using (true)
  with check (
    name is not distinct from
      ((public."pages_row"(pages.id)).name)
    and category is not distinct from
      ((public."pages_row"(pages.id)).category)
    and about is not distinct from
      ((public."pages_row"(pages.id)).about)
    and avatar is not distinct from
      ((public."pages_row"(pages.id)).avatar)
    and cover is not distinct from
      ((public."pages_row"(pages.id)).cover)
    and "ownerId" is not distinct from
      ((public."pages_row"(pages.id))."ownerId")
    and "createdAt" is not distinct from
      ((public."pages_row"(pages.id))."createdAt")
    and (
      ( -- follow: append exactly the caller's uid
        jsonb_array_length(followers)
          = jsonb_array_length(((public."pages_row"(pages.id)).followers)) + 1
        and followers @> ((public."pages_row"(pages.id)).followers)
        and followers @> jsonb_build_array((select auth.uid())::text)
        and not (((public."pages_row"(pages.id)).followers)
                 @> jsonb_build_array((select auth.uid())::text))
      )
      or
      ( -- unfollow: remove exactly the caller's uid
        jsonb_array_length(followers)
          = jsonb_array_length(((public."pages_row"(pages.id)).followers)) - 1
        and ((public."pages_row"(pages.id)).followers) @> followers
        and ((public."pages_row"(pages.id)).followers)
              @> jsonb_build_array((select auth.uid())::text)
        and not (followers @> jsonb_build_array((select auth.uid())::text))
      )
    )
  );

create policy pages_delete on public.pages
  for delete to authenticated
  using ("ownerId" = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- reviews
-- Guarantee: read by all signed-in; create as self with rating 1–5;
-- update by author/admin with authorId/pageId pinned and rating in
-- range; delete by author/admin. (The rating range is also a table
-- CHECK and one-per-user-per-page a unique index in schema.sql.)
-- =====================================================================
create policy reviews_select on public.reviews
  for select to authenticated
  using (true);

create policy reviews_insert on public.reviews
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "authorId" = (select auth.uid())::text
    and rating between 1 and 5
  );

create policy reviews_update on public.reviews
  for update to authenticated
  using ("authorId" = (select auth.uid())::text or public.is_admin())
  with check (
    "authorId" is not distinct from
      ((public."reviews_row"(reviews.id))."authorId")
    and "pageId" is not distinct from
      ((public."reviews_row"(reviews.id))."pageId")
    and rating between 1 and 5
  );

create policy reviews_delete on public.reviews
  for delete to authenticated
  using ("authorId" = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- events
-- Guarantee: posts-shaped reads (creator field is createdBy); create
-- as self (active writer); update by admin/creator, or any signed-in
-- user with every content/audience field pinned (only going/
-- interested move — RSVP); delete by creator/admin.
-- =====================================================================
create policy events_select on public.events
  for select to authenticated
  using (
    "createdBy" = (select auth.uid())::text
    or public.is_admin()
    or visibility = 'public'
    or (select auth.uid())::text = any ("audienceIds")
  );

create policy events_insert on public.events
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "createdBy" = (select auth.uid())::text
  );

-- 2026-11-25: createdBy/createdAt pinned (same M1 shape as the
-- posts/stories/groups creator branches — ownership and timestamps
-- never move; the app has no event-edit flow at all, create-only).
create policy events_update_admin_creator on public.events
  for update to authenticated
  using (public.is_admin() or "createdBy" = (select auth.uid())::text)
  with check (
    (public.is_admin() or "createdBy" = (select auth.uid())::text)
    and "createdBy" is not distinct from
      ((public."events_row"(events.id))."createdBy")
    and "createdAt" is not distinct from
      ((public."events_row"(events.id))."createdAt")
  );

-- RSVP branch: content/audience fields pinned via self-lookup,
-- exactly the set firestore.rules pins. (The pin self-lookups are
-- filtered by events_select — same safe-direction narrowing as posts
-- engagement, summary #5; clients RSVP on events they have loaded.)
-- 2026-11-25 audit M4: going/interested were unpinned — anyone
-- could add/remove OTHER people's uids. Each list now carries the
-- ±-caller delta (toggleEventRsvp moves both lists in one write:
-- the chosen list ± self, the other − self), and the caller may
-- not end up on both lists in one write.
create policy events_update_rsvp on public.events
  for update to authenticated
  using (true)
  with check (
    "createdBy" is not distinct from
      ((public."events_row"(events.id))."createdBy")
    and title is not distinct from
      ((public."events_row"(events.id)).title)
    and description is not distinct from
      ((public."events_row"(events.id)).description)
    and "dateTime" is not distinct from
      ((public."events_row"(events.id))."dateTime")
    and location is not distinct from
      ((public."events_row"(events.id)).location)
    and cover is not distinct from
      ((public."events_row"(events.id)).cover)
    and visibility is not distinct from
      ((public."events_row"(events.id)).visibility)
    and "audienceIds" is not distinct from
      ((public."events_row"(events.id))."audienceIds")
    and "createdAt" is not distinct from
      ((public."events_row"(events.id))."createdAt")
    and public.uid_list_delta_ok(
          ((public."events_row"(events.id)).going), going,
          (select auth.uid())::text)
    and public.uid_list_delta_ok(
          ((public."events_row"(events.id)).interested), interested,
          (select auth.uid())::text)
    and not (
      going @> jsonb_build_array((select auth.uid())::text)
      and interested @> jsonb_build_array((select auth.uid())::text)
      and not (
        ((public."events_row"(events.id)).going)
          @> jsonb_build_array((select auth.uid())::text)
        and ((public."events_row"(events.id)).interested)
          @> jsonb_build_array((select auth.uid())::text)
      )
    )
  );

create policy events_delete on public.events
  for delete to authenticated
  using ("createdBy" = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- conversations
-- Guarantee: read by participants or admins; create with caller ∈
-- participants, ≥ 2 participants, group chats only with
-- createdBy = caller; update by participants with identity columns
-- pinned and membership/per-user columns delta-checked (2026-11-25
-- M2) — or by a NON-participant adding exactly themselves to
-- participants only, when the conversation carries a joinCode
-- backed by a live invites doc; delete admin-only.
-- =====================================================================
create policy conversations_select on public.conversations
  for select to authenticated
  using (
    (select auth.uid())::text = any (participants)
    or public.is_admin()
  );

create policy conversations_insert on public.conversations
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and (select auth.uid())::text = any (participants)
    and cardinality(participants) >= 2
    and (not "isGroup" or "createdBy" = (select auth.uid())::text)
  );

-- Participant branch. Firestore checked membership on the OLD row
-- only and left the new row unconstrained; the original port kept
-- an explicit `with check (true)`. 2026-11-25 audit M2: that let
-- ANY participant rewrite the member list — kick the group
-- creator, add strangers to a private chat — and every other
-- column besides. The branch now pins the identity columns and
-- constrains each mutable column to the deltas src/api.js actually
-- performs, while USING still tests the OLD row only. (One delta
-- below — a member removing THEMSELVES — is permitted by this
-- WITH CHECK but still rejected by Postgres itself: an UPDATE's
-- new row must remain visible under conversations_select, and a
-- departed member no longer is. That wall predates this pack —
-- the old check(true) hit it identically — and lifting it needs a
-- SECURITY DEFINER leave-conversation RPC, not a policy change;
-- flagged in the 2026-11-25 fix-pack report, not silently worked
-- around here.):
--   participants: unchanged, or (group chats only) additions of
--     any size (addGroupMembers), or removal of exactly one member
--     who is the caller, or removed by the creator/admin
--     (removeGroupChatMember), never dropping below 2;
--   archivedBy/mutedBy/pinnedBy: ± the caller's own uid
--     (setConversationFlag);
--   acceptedBy: the caller may only ADD themselves
--     (acceptConversationRequest / replying to a request);
--   mutedUntil: only the caller's own key may move
--     (setConversationMute);
--   joinCode: may only be SET ('' -> code, createConversationInvite);
--   typing: pinned (live typing is a broadcast heartbeat now, no
--     DB write — setTyping);
--   theme/emoji/nicknames/title/vanish: free for participants by
--     design (chat themes, quick emoji, Messenger-style nicknames,
--     group rename, vanish toggle).
create policy conversations_update_participant on public.conversations
  for update to authenticated
  using ((select auth.uid())::text = any (participants))
  with check (
    "isGroup" is not distinct from
      ((public."conversations_row"(conversations.id))."isGroup")
    and "createdBy" is not distinct from
      ((public."conversations_row"(conversations.id))."createdBy")
    and "createdAt" is not distinct from
      ((public."conversations_row"(conversations.id))."createdAt")
    and typing is not distinct from
      ((public."conversations_row"(conversations.id)).typing)
    and (
      participants is not distinct from
        ((public."conversations_row"(conversations.id)).participants)
      or (
        ((public."conversations_row"(conversations.id))."isGroup")
        and participants
              @> ((public."conversations_row"(conversations.id)).participants)
        and cardinality(participants)
              > cardinality(((public."conversations_row"(conversations.id)).participants))
      )
      or (
        ((public."conversations_row"(conversations.id))."isGroup")
        and cardinality(participants)
              = cardinality(((public."conversations_row"(conversations.id)).participants)) - 1
        and ((public."conversations_row"(conversations.id)).participants)
              @> participants
        and cardinality(participants) >= 2
        and exists (
          select 1
          from unnest(((public."conversations_row"(conversations.id)).participants)) x
          where x <> all (participants)
            and (
              x = (select auth.uid())::text
              or ((public."conversations_row"(conversations.id))."createdBy")
                   = (select auth.uid())::text
              or public.is_admin()
            ))
      )
    )
    and public.uid_list_delta_ok(
          ((public."conversations_row"(conversations.id))."archivedBy"),
          "archivedBy", (select auth.uid())::text)
    and public.uid_list_delta_ok(
          ((public."conversations_row"(conversations.id))."mutedBy"),
          "mutedBy", (select auth.uid())::text)
    and public.uid_list_delta_ok(
          ((public."conversations_row"(conversations.id))."pinnedBy"),
          "pinnedBy", (select auth.uid())::text)
    and public.jsonb_list_without_uid(
          ((public."conversations_row"(conversations.id))."acceptedBy"),
          (select auth.uid())::text)
          = public.jsonb_list_without_uid(
              "acceptedBy", (select auth.uid())::text)
    and public.jsonb_uid_count(
          "acceptedBy", (select auth.uid())::text)
          >= public.jsonb_uid_count(
               ((public."conversations_row"(conversations.id))."acceptedBy"),
               (select auth.uid())::text)
    and ("mutedUntil" - (select auth.uid())::text)
          = (((public."conversations_row"(conversations.id))."mutedUntil")
             - (select auth.uid())::text)
    and (
      "joinCode" is not distinct from
        ((public."conversations_row"(conversations.id))."joinCode")
      or (
        ((public."conversations_row"(conversations.id))."joinCode") = ''
        and "joinCode" <> ''
      )
    )
  );

-- Self-join branch (invite links): caller ∉ old participants; new
-- participants = old + exactly the caller; every other column pinned
-- via self-lookup; the OLD joinCode (from the self-lookup — the
-- pre-update value, exactly what the Firestore rule reads) is
-- non-empty and backed by a live invites doc.
--
-- ⚠ KNOWN ISSUE — flagged for Phase 2, construction kept as spec'd
-- in RLS_NOTES.md: Postgres applies RLS to subqueries inside policy
-- expressions too, so the self-lookups against public.conversations
-- below are filtered by conversations_select (participants/admin).
-- For a NON-participant joiner they return no row, every pin
-- comparison goes null, and this policy can never pass — the
-- invite-join would be dead despite matching the notes' construction
-- (the same filtering only *narrows* the posts/stories/events pin
-- branches, because there the caller normally passes SELECT).
-- Remedy for Phase 2 to choose deliberately: read the pre-update row
-- through a SECURITY DEFINER helper in the schema.sql pattern (e.g.
-- public.conversation_before(text) returning the row), or fold the
-- whole join into a SECURITY DEFINER RPC join_via_invite(text)
-- analogous to file_appeal() below. The Phase 6 checklist item
-- "invite self-join works with a live code" will catch this if it is
-- applied unpatched.
create policy conversations_update_self_join on public.conversations
  for update to authenticated
  using (not ((select auth.uid())::text = any (participants)))
  with check (
    (select auth.uid())::text = any (participants)
    and cardinality(participants)
          = cardinality(((public."conversations_row"(conversations.id)).participants)) + 1
    and participants @> ((public."conversations_row"(conversations.id)).participants)
    and "isGroup" is not distinct from
      ((public."conversations_row"(conversations.id))."isGroup")
    and title is not distinct from
      ((public."conversations_row"(conversations.id)).title)
    and "createdBy" is not distinct from
      ((public."conversations_row"(conversations.id))."createdBy")
    and "createdAt" is not distinct from
      ((public."conversations_row"(conversations.id))."createdAt")
    and typing is not distinct from
      ((public."conversations_row"(conversations.id)).typing)
    and theme is not distinct from
      ((public."conversations_row"(conversations.id)).theme)
    and emoji is not distinct from
      ((public."conversations_row"(conversations.id)).emoji)
    and nicknames is not distinct from
      ((public."conversations_row"(conversations.id)).nicknames)
    and "archivedBy" is not distinct from
      ((public."conversations_row"(conversations.id))."archivedBy")
    and "mutedBy" is not distinct from
      ((public."conversations_row"(conversations.id))."mutedBy")
    and "pinnedBy" is not distinct from
      ((public."conversations_row"(conversations.id))."pinnedBy")
    and "acceptedBy" is not distinct from
      ((public."conversations_row"(conversations.id))."acceptedBy")
    and "mutedUntil" is not distinct from
      ((public."conversations_row"(conversations.id))."mutedUntil")
    and vanish is not distinct from
      ((public."conversations_row"(conversations.id)).vanish)
    and "joinCode" is not distinct from
      ((public."conversations_row"(conversations.id))."joinCode")
    and ((public."conversations_row"(conversations.id))."joinCode") <> ''
    and exists (
      select 1 from public.invites i
      where i.id = ((public."conversations_row"(conversations.id))."joinCode")
    )
  );

create policy conversations_delete on public.conversations
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- invites
-- Guarantee: any signed-in user may read a code (possession of the
-- code is the secret); create by any participant of the conversation
-- (Firestore parity — amended 2026-11-22 during Phase 2; the first
-- applied version required the conversation's creator, which was
-- narrower than Firestore); never update; delete by its creator.
-- =====================================================================
create policy invites_select on public.invites
  for select to authenticated
  using (true);

-- Note: the EXISTS subquery is filtered by conversations_select;
-- a participant can read their own conversation, so it resolves.
create policy invites_insert on public.invites
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "createdBy" = (select auth.uid())::text
    and exists (
          select 1 from public.conversations c
          where c.id = "conversationId"
            and (select auth.uid())::text = any (c.participants))
  );

-- No UPDATE policy: updates are denied for everyone (= Firestore
-- `update: if false`).

create policy invites_delete on public.invites
  for delete to authenticated
  using ("createdBy" = (select auth.uid())::text);

-- =====================================================================
-- messages
-- Guarantee: read by the denormalised participants snapshot or
-- admins; create as self with caller ∈ message participants AND ∈
-- the conversation's live participants — or by an admin as a bot
-- with the bot in both sets; update by any participant with the
-- identity columns pinned and every mutable column guarded to its
-- own flow's delta (sender-only text/unsend, self-only readBy/
-- hiddenFor/reactions/poll votes — 2026-11-25 M3); delete
-- admin-only.
-- =====================================================================
create policy messages_select on public.messages
  for select to authenticated
  using (
    (select auth.uid())::text = any (participants)
    or public.is_admin()
  );

create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and (
      (
        "senderId" = (select auth.uid())::text
        and (select auth.uid())::text = any (participants)
        and exists (
              select 1 from public.conversations c
              where c.id = "conversationId"
                and (select auth.uid())::text = any (c.participants))
      )
      or (
        public.is_admin()
        and public.is_bot_user("senderId")
        and "senderId" = any (participants)
        and exists (
              select 1 from public.conversations c
              where c.id = "conversationId"
                and "senderId" = any (c.participants))
      )
    )
  );

-- 2026-11-25 audit M3: only senderId/participants/text were
-- pinned — a chat partner could set unsent=true on YOUR messages
-- (censorship), swap your shared file/image URLs, forge readBy,
-- or rewrite a chat poll's votes. The check is now field-wise:
-- identity columns are pinned outright (conversationId joins them
-- — it was unpinned, so a message could be moved into another
-- conversation), and every mutable column carries the exact guard
-- for the src/api.js flow that writes it. Field-wise guards
-- compose: each legitimate write (read receipts, reactions, pin,
-- hide-for-me, poll vote, sender edit/unsend) touches a disjoint
-- field set and passes its own guard while every other field
-- stays pinned by its guard.
create policy messages_update on public.messages
  for update to authenticated
  using ((select auth.uid())::text = any (participants))
  with check (
    "senderId" is not distinct from
      ((public."messages_row"(messages.id))."senderId")
    and "conversationId" is not distinct from
      ((public."messages_row"(messages.id))."conversationId")
    and participants is not distinct from
      ((public."messages_row"(messages.id)).participants)
    and "createdAt" is not distinct from
      ((public."messages_row"(messages.id))."createdAt")
    and sticker is not distinct from
      ((public."messages_row"(messages.id)).sticker)
    and location is not distinct from
      ((public."messages_row"(messages.id)).location)
    and file is not distinct from
      ((public."messages_row"(messages.id)).file)
    and mentions is not distinct from
      ((public."messages_row"(messages.id)).mentions)
    and "replyToId" is not distinct from
      ((public."messages_row"(messages.id))."replyToId")
    and "replyToName" is not distinct from
      ((public."messages_row"(messages.id))."replyToName")
    and "replyToText" is not distinct from
      ((public."messages_row"(messages.id))."replyToText")
    and forwarded is not distinct from
      ((public."messages_row"(messages.id)).forwarded)
    and vanish is not distinct from
      ((public."messages_row"(messages.id)).vanish)
    and "expiresAt" is not distinct from
      ((public."messages_row"(messages.id))."expiresAt")
    -- text/editedAt: only the sender edits (editMessage)
    and (
      text is not distinct from
        ((public."messages_row"(messages.id)).text)
      or (select auth.uid())::text
           = ((public."messages_row"(messages.id))."senderId")
    )
    and (
      "editedAt" is not distinct from
        ((public."messages_row"(messages.id))."editedAt")
      or (select auth.uid())::text
           = ((public."messages_row"(messages.id))."senderId")
    )
    -- unsent: only the sender, only false -> true (unsendMessage)
    and (
      unsent is not distinct from
        ((public."messages_row"(messages.id)).unsent)
      or (
        (select auth.uid())::text
          = ((public."messages_row"(messages.id))."senderId")
        and unsent
        and not ((public."messages_row"(messages.id)).unsent)
      )
    )
    -- image/audio: only cleared, by the sender, as part of unsend
    and (
      image is not distinct from
        ((public."messages_row"(messages.id)).image)
      or (
        (select auth.uid())::text
          = ((public."messages_row"(messages.id))."senderId")
        and unsent
        and not ((public."messages_row"(messages.id)).unsent)
        and image = ''
      )
    )
    and (
      audio is not distinct from
        ((public."messages_row"(messages.id)).audio)
      or (
        (select auth.uid())::text
          = ((public."messages_row"(messages.id))."senderId")
        and unsent
        and not ((public."messages_row"(messages.id)).unsent)
        and audio = ''
      )
    )
    -- status/readBy: read receipts only — status may become
    -- 'read', readBy may only gain the caller's own uid
    -- (markConversationRead)
    and (
      status is not distinct from
        ((public."messages_row"(messages.id)).status)
      or status = 'read'
    )
    and public.uid_list_add_ok(
          ((public."messages_row"(messages.id))."readBy"), "readBy",
          (select auth.uid())::text)
    -- reactions: only the caller's own reactions move
    -- (toggleMessageReaction); the sender's unsend may clear all
    and (
      public.msg_reactions_delta_ok(
        ((public."messages_row"(messages.id)).reactions), reactions,
        (select auth.uid())::text)
      or (
        (select auth.uid())::text
          = ((public."messages_row"(messages.id))."senderId")
        and unsent
        and not ((public."messages_row"(messages.id)).unsent)
        and reactions = '{}'::jsonb
      )
    )
    -- pin trio: unchanged, or a pin stamped with the caller, or an
    -- unpin reset (togglePinMessage — any participant may pin)
    and (
      (
        pinned is not distinct from
          ((public."messages_row"(messages.id)).pinned)
        and "pinnedBy" is not distinct from
          ((public."messages_row"(messages.id))."pinnedBy")
        and "pinnedAt" is not distinct from
          ((public."messages_row"(messages.id))."pinnedAt")
      )
      or (
        pinned
        and "pinnedBy" = (select auth.uid())::text
      )
      or (
        not pinned
        and "pinnedBy" = ''
        and "pinnedAt" = 0
      )
    )
    -- hiddenFor: only gains the caller's own uid (hideMessage)
    and public.uid_list_add_ok(
          ((public."messages_row"(messages.id))."hiddenFor"), "hiddenFor",
          (select auth.uid())::text)
    -- chat poll: votes move only at the caller's own uid
    -- (voteChatPoll)
    and public.chat_poll_delta_ok(
          ((public."messages_row"(messages.id)).poll), poll,
          (select auth.uid())::text)
  );

create policy messages_delete on public.messages
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- friendships
-- Guarantee: read by from/to/admins; create as from = caller with
-- status='pending' (active writer); update by admins, or by the
-- recipient only, flipping pending → accepted and changing nothing
-- else (the sender accepting their own request is the consent bypass
-- this rule exists to stop); delete by either side or admins.
-- =====================================================================
create policy friendships_select on public.friendships
  for select to authenticated
  using (
    "from" = (select auth.uid())::text
    or "to" = (select auth.uid())::text
    or public.is_admin()
  );

create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "from" = (select auth.uid())::text
    and status = 'pending'
  );

create policy friendships_update_admin on public.friendships
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy friendships_update_recipient_accept on public.friendships
  for update to authenticated
  using (
    "to" = (select auth.uid())::text
    and status = 'pending'
  )
  with check (
    status = 'accepted'
    and "from" is not distinct from
      ((public."friendships_row"(friendships.id))."from")
    and "to" is not distinct from
      ((public."friendships_row"(friendships.id))."to")
    and "createdAt" is not distinct from
      ((public."friendships_row"(friendships.id))."createdAt")
  );

create policy friendships_delete on public.friendships
  for delete to authenticated
  using (
    "from" = (select auth.uid())::text
    or "to" = (select auth.uid())::text
    or public.is_admin()
  );

-- Belt-and-braces for the accept (RLS_NOTES.md, friendships flag):
-- the RLS policy above is the outer gate for direct updates; the app
-- should ALSO route accepts through this SECURITY DEFINER function,
-- whose internal checks are then the enforcement (a definer function
-- bypasses RLS, so the checks below are the whole guarantee on this
-- path — recipient + pending + status-only, re-verified at write
-- time, immune to future columns escaping a pin list).
create or replace function public.accept_friendship(p_friendship_id text)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := (select auth.uid())::text;
  v_row public.friendships;
begin
  if v_uid is null then
    raise exception 'accept_friendship: caller is not signed in';
  end if;

  update public.friendships f
     set status = 'accepted'
   where f.id = p_friendship_id
     and f."to" = v_uid
     and f.status = 'pending'
  returning * into v_row;

  if not found then
    raise exception
      'accept_friendship: no pending request % addressed to the caller',
      p_friendship_id;
  end if;

  return v_row;
end;
$$;

revoke execute on function public.accept_friendship(text) from public, anon;
grant execute on function public.accept_friendship(text) to authenticated;

-- =====================================================================
-- blocks
-- Guarantee: read by the blocker or admins; create as by = caller;
-- never update; delete by the blocker.
-- =====================================================================
create policy blocks_select on public.blocks
  for select to authenticated
  using (by = (select auth.uid())::text or public.is_admin());

create policy blocks_insert on public.blocks
  for insert to authenticated
  with check (by = (select auth.uid())::text);

-- No UPDATE policy: updates are denied for everyone (= Firestore
-- `update: if false`).

create policy blocks_delete on public.blocks
  for delete to authenticated
  using (by = (select auth.uid())::text);

-- =====================================================================
-- notifications
-- Guarantee: read by the owner or admins; create with actorId
-- pinned to the caller, admins exempt (TIGHTENED 2026-11-22 with
-- Limon's approval — a deliberate deviation from the Firestore
-- mirror, see the note at the insert policy below); update by the
-- owner; delete by owner or admins.
-- =====================================================================
create policy notifications_select on public.notifications
  for select to authenticated
  using ("userId" = (select auth.uid())::text or public.is_admin());

-- ADOPTED 2026-11-22 (Limon approved): actorId is pinned to the
-- caller (admins exempt), closing Firestore's forge-any-notification
-- hole. Deliberate deviation from the 1:1 mirror (RLS_NOTES.md,
-- notifications flag): the faithful version allowed any signed-in
-- user to create a notification for anyone. Every real write path
-- in api.js already sets actorId to the caller, so no legitimate
-- flow changes.
create policy notifications_insert_actor_pinned on public.notifications
  for insert to authenticated
  with check (
    "actorId" = (select auth.uid())::text
    or public.is_admin()
  );

-- -------------------------------------------------------------------
-- (This block previously held the OPTIONAL proposal to pin actorId,
-- marked as needing Limon's approval. He approved it on 2026-11-22,
-- so the actor-pinned insert policy above is the applied state and
-- the old faithful policy no longer exists.)
-- -------------------------------------------------------------------

create policy notifications_update on public.notifications
  for update to authenticated
  using ("userId" = (select auth.uid())::text)
  with check (true);

create policy notifications_delete on public.notifications
  for delete to authenticated
  using ("userId" = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- reports
-- Guarantee: read by moderators, the reporter (reporterId), or the
-- reported author (targetAuthorId); create as reporterId = caller
-- with status='pending'; update by moderators — or by the reported
-- author filing one appeal: only when a decision exists with
-- outcome <> 'none', only from appeal.status = 'none', changing only
-- the appeal object, to status='requested' with appeal.byId =
-- caller; delete admin-only.
-- =====================================================================
create policy reports_select on public.reports
  for select to authenticated
  using (
    public.is_moderator()
    or "reporterId" = (select auth.uid())::text
    or "targetAuthorId" = (select auth.uid())::text
  );

create policy reports_insert on public.reports
  for insert to authenticated
  with check (
    "reporterId" = (select auth.uid())::text
    and status = 'pending'
  );

-- Moderators are the ONLY direct-update path. Non-moderators get no
-- UPDATE policy on reports at all: the appeal branch cannot be a
-- policy (Firestore's hasOnly(['appeal']) is a whitelist, RLS pins
-- are blacklists — RLS_NOTES.md summary #1), so it is enforced by
-- the file_appeal() RPC below, which is the reported author's only
-- write path and reproduces the whitelist by construction.
create policy reports_update_moderator on public.reports
  for update to authenticated
  using (public.is_moderator())
  with check (public.is_moderator());

create policy reports_delete on public.reports
  for delete to authenticated
  using (public.is_admin());

-- file_appeal(p_report_id, p_text) → the new appeal object.
-- Mirrors api.js appealReport()'s client-side validation, moved
-- server-side: (a) caller = targetAuthorId, a decision exists with
-- outcome <> 'none', current appeal.status = 'none'; (b) updates
-- ONLY the appeal column to {status:'requested', text, byId: caller,
-- byName: caller's name, at: now (epoch ms), reason: ''}; (c)
-- returns the new appeal. SECURITY DEFINER: runs as the table owner
-- and bypasses RLS, so the checks above are the whole enforcement —
-- that is precisely what makes the whitelist reproducible.
create or replace function public.file_appeal(p_report_id text, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    text := (select auth.uid())::text;
  v_report public.reports;
  v_name   text;
  v_appeal jsonb;
begin
  if v_uid is null then
    raise exception 'file_appeal: caller is not signed in';
  end if;

  select * into v_report from public.reports where id = p_report_id;
  if not found then
    raise exception 'file_appeal: report % not found', p_report_id;
  end if;

  if v_report."targetAuthorId" <> v_uid then
    raise exception
      'file_appeal: only the reported author may appeal this report';
  end if;

  if v_report.decision is null
     or not (v_report.decision ? 'outcome')
     or (v_report.decision ->> 'outcome') = 'none' then
    raise exception 'file_appeal: report has no appealable decision';
  end if;

  if coalesce(v_report.appeal ->> 'status', 'none') <> 'none' then
    raise exception
      'file_appeal: an appeal has already been filed for this decision';
  end if;

  select u.name into v_name from public.users u where u.id = v_uid;

  v_appeal := jsonb_build_object(
    'status', 'requested',
    'text',   coalesce(p_text, ''),
    'byId',   v_uid,
    'byName', coalesce(v_name, ''),
    'at',     (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'reason', ''
  );

  update public.reports set appeal = v_appeal where id = p_report_id;

  return v_appeal;
end;
$$;

revoke execute on function public.file_appeal(text, text) from public, anon;
grant execute on function public.file_appeal(text, text) to authenticated;

-- =====================================================================
-- adminLogs
-- Guarantee: read by admins only (moderators/analysts excluded);
-- create by moderators+ with adminId = caller (nobody forges another
-- staffer's audit entries); never update; delete superadmin only.
-- =====================================================================
create policy admin_logs_select on public."adminLogs"
  for select to authenticated
  using (public.is_admin());

create policy admin_logs_insert on public."adminLogs"
  for insert to authenticated
  with check (
    public.is_moderator()
    and "adminId" = (select auth.uid())::text
  );

-- No UPDATE policy: entries are append-only (= Firestore
-- `update: if false`).

create policy admin_logs_delete on public."adminLogs"
  for delete to authenticated
  using (public.is_superadmin());

-- =====================================================================
-- announcements
-- Guarantee: read by all signed-in users; write admin-only.
-- =====================================================================
create policy announcements_select on public.announcements
  for select to authenticated
  using (true);

create policy announcements_insert on public.announcements
  for insert to authenticated
  with check (public.is_admin());

create policy announcements_update on public.announcements
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy announcements_delete on public.announcements
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- bots
-- Guarantee: profiles readable by all signed-in users; all writes
-- admin-only.
-- =====================================================================
create policy bots_select on public.bots
  for select to authenticated
  using (true);

create policy bots_insert on public.bots
  for insert to authenticated
  with check (public.is_admin());

create policy bots_update on public.bots
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy bots_delete on public.bots
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- botBrains
-- Guarantee: admin read/write, nobody else — holds the bots' live
-- prompts and provider/model stamps.
-- =====================================================================
create policy bot_brains_select on public."botBrains"
  for select to authenticated
  using (public.is_admin());

create policy bot_brains_insert on public."botBrains"
  for insert to authenticated
  with check (public.is_admin());

create policy bot_brains_update on public."botBrains"
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy bot_brains_delete on public."botBrains"
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- botMemories
-- Guarantee: admin read/write, nobody else — holds the bots' private
-- per-bot memory lists.
-- =====================================================================
create policy bot_memories_select on public."botMemories"
  for select to authenticated
  using (public.is_admin());

create policy bot_memories_insert on public."botMemories"
  for insert to authenticated
  with check (public.is_admin());

create policy bot_memories_update on public."botMemories"
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy bot_memories_delete on public."botMemories"
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- botConversations
-- Guarantee: admin read/write, nobody else. (Rules-only legacy table
-- — no live writer exists in either system; admin-only parity is the
-- whole spec, see schema.sql.)
-- =====================================================================
create policy bot_conversations_select on public."botConversations"
  for select to authenticated
  using (public.is_admin());

create policy bot_conversations_insert on public."botConversations"
  for insert to authenticated
  with check (public.is_admin());

create policy bot_conversations_update on public."botConversations"
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy bot_conversations_delete on public."botConversations"
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- botRunners
-- Guarantee: admin read/write, nobody else — holds the autocycle
-- window claims and the persisted decision history. The claim maps
-- to `insert … on conflict (id) do nothing` (the PK makes it atomic
-- in one statement); the runner always acts as an admin session,
-- exactly as on Firestore, so no policy widening is needed.
-- =====================================================================
create policy bot_runners_select on public."botRunners"
  for select to authenticated
  using (public.is_admin());

create policy bot_runners_insert on public."botRunners"
  for insert to authenticated
  with check (public.is_admin());

create policy bot_runners_update on public."botRunners"
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy bot_runners_delete on public."botRunners"
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- botActivities
-- Guarantee: read by admins; write: FALSE for every client — in
-- Firestore only the (never-deployed) Functions Admin SDK could
-- write these, so nothing writes them in live mode today.
-- Postgres equivalent (RLS_NOTES.md summary #3): SELECT for admins +
-- NO insert/update/delete policies at all, leaving writes to
-- service_role (which bypasses RLS). The guarantee — clients cannot
-- write — is preserved; the potential-writer set changes from
-- "nobody" to "service-key holder", which is why the runner must NOT
-- be handed a service key as part of this migration.
-- =====================================================================
create policy bot_activities_select on public."botActivities"
  for select to authenticated
  using (public.is_admin());

-- (Intentionally no INSERT/UPDATE/DELETE policies on this table.)

-- =====================================================================
-- botLogs
-- Guarantee: read by admins; write: FALSE for every client — same
-- Functions-only situation and same mapping as botActivities above.
-- =====================================================================
create policy bot_logs_select on public."botLogs"
  for select to authenticated
  using (public.is_admin());

-- (Intentionally no INSERT/UPDATE/DELETE policies on this table.)

-- =====================================================================
-- botSettings
-- Guarantee: read by any signed-in user (both the 'global' kill
-- switch and the 'counters' doc ride the same rule); write
-- admin-only. (Faithful mirror: yes, counters are readable by any
-- signed-in user today too — noted in RLS_NOTES.md, not changed.)
-- =====================================================================
create policy bot_settings_select on public."botSettings"
  for select to authenticated
  using (true);

create policy bot_settings_insert on public."botSettings"
  for insert to authenticated
  with check (public.is_admin());

create policy bot_settings_update on public."botSettings"
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy bot_settings_delete on public."botSettings"
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- botSecrets
-- Guarantee: admin read/write; non-admins must never read the
-- provider keys — the single most sensitive rule in the system.
-- All four operations are admin-only and there is deliberately NO
-- other policy on this table. Phase 6 staging must probe this table
-- explicitly (signed in as a plain user, and with the bare anon key:
-- expect 0 rows / denied) — see RLS_NOTES.md.
-- =====================================================================
create policy bot_secrets_select on public."botSecrets"
  for select to authenticated
  using (public.is_admin());

create policy bot_secrets_insert on public."botSecrets"
  for insert to authenticated
  with check (public.is_admin());

create policy bot_secrets_update on public."botSecrets"
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy bot_secrets_delete on public."botSecrets"
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- config
-- Guarantee: read by all signed-in users (the client mirrors
-- config/app for maintenance mode, the registration gate and AI
-- routing); write admin-only. The users-create rule's cross-table
-- read of registrationOpen is public.registration_open() (SECURITY
-- DEFINER, schema.sql) — missing row / null flag means open.
-- =====================================================================
create policy config_select on public.config
  for select to authenticated
  using (true);

create policy config_insert on public.config
  for insert to authenticated
  with check (public.is_admin());

create policy config_update on public.config
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy config_delete on public.config
  for delete to authenticated
  using (public.is_admin());

commit;

-- =====================================================================
-- VERIFICATION QUERIES (run manually in the Supabase SQL editor
-- after applying schema.sql + this file; all read-only)
--
-- 1. Every policy that now exists, per table and command:
--
--    select tablename, policyname, cmd, roles
--      from pg_policies
--     where schemaname = 'public'
--     order by tablename, cmd, policyname;
--
-- 2. Policy count per table — expect >= 3 for every table EXCEPT
--    "botActivities" and "botLogs", which must have exactly 1
--    (the admin SELECT) and no write policies at all:
--
--    select c.relname as table_name, count(p.policyname) as policies
--      from pg_class c
--      join pg_namespace n on n.oid = c.relnamespace
--      left join pg_policies p
--        on p.schemaname = 'public' and p.tablename = c.relname
--     where n.nspname = 'public' and c.relkind = 'r'
--     group by c.relname
--     order by c.relname;
--
-- 3. RLS is enabled everywhere (set by schema.sql; all rows true):
--
--    select c.relname, c.relrowsecurity
--      from pg_class c
--      join pg_namespace n on n.oid = c.relnamespace
--     where n.nspname = 'public' and c.relkind = 'r'
--     order by c.relname;
--
-- 4. No policy anywhere targets the anon or public roles:
--
--    select tablename, policyname, roles
--      from pg_policies
--     where schemaname = 'public'
--       and (roles @> array['anon']::name[] or roles @> array['public']::name[]);
--    -- expect: 0 rows
--
-- 5. The two RPCs exist, are SECURITY DEFINER, and are executable
--    only by authenticated:
--
--    select p.proname, p.prosecdef as security_definer,
--           has_function_privilege('authenticated', p.oid, 'execute') as auth_can_execute,
--           has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
--      from pg_proc p
--      join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('file_appeal', 'accept_friendship');
--    -- expect: 2 rows, security_definer = true,
--    --         auth_can_execute = true, anon_can_execute = false
--
-- 6. Behavioural probes (the full checklist is in RLS_NOTES.md,
--    "Policy test checklist"): as a plain signed-in user, each of
--    these must return 0 rows / be denied —
--      select * from "botSecrets";
--      select * from "botBrains";
--      select * from "adminLogs";
--    and with the bare anon key (no session), every table read must
--    be denied.
-- =====================================================================
