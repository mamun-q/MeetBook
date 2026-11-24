-- =====================================================================
-- fix-rls-engagement-2026-11-25.sql — RLS hardening (2026-11-25 audit)
-- STATUS: READY TO APPLY — paste this WHOLE file into the Supabase
-- dashboard SQL Editor and Run it once (steps at the bottom). It is
-- idempotent: every function is CREATE OR REPLACE and every policy
-- is DROP IF EXISTS + CREATE, so running it twice is harmless.
-- The repo source of truth (supabase/policies.sql) carries the same
-- statements; tests/rls-engagement-fix.test.js pins the two files
-- together so they cannot drift.
--
-- WHAT IT FIXES (findings from
-- ~/workspace/meetbook-audit-2026-11-25/CODE-AUDIT.md):
--   H1  users_update_self_admin pinned only role/isBot — a banned
--       user could PATCH their own row back to status='active'
--       (voiding every writer_status_ok() gate) and anyone could
--       self-grant verified=true or fake their followers list.
--       Now: status/verified move only when an ADMIN changes
--       SOMEONE ELSE's row; followers/botId/createdAt/email pinned.
--   H2  posts_update_engagement left comments/likes/reactions/
--       savedBy/poll/shares/pinned unpinned — any signed-in user
--       could wipe every comment on any post, forge like counts or
--       rewrite poll votes with one PostgREST PATCH. Every
--       engagement column now carries a delta check that permits
--       exactly the writes the app performs (own like/save toggle,
--       own reaction key, own poll vote, +1 share, group-creator
--       pin, single-comment append/delete/reply deltas).
--   M1  posts_update_author was WITH CHECK (true) — authors could
--       rewrite authorId (impersonation), createdAt, placement.
--       Now only text/editedAt move (the app's editPost). Same
--       shape fixed on the two sibling branches the audit named:
--       stories_update_author_admin (all columns pinned — the app
--       has no story edit flow) and groups_update_admin_creator
--       (createdBy/createdAt pinned; members move only by the
--       creator's exact +1/-1 deltas or by an admin). The events
--       creator branch got the same createdBy/createdAt pin.
--   M2  conversations_update_participant was WITH CHECK (true) —
--       any participant could kick the group creator or add
--       strangers to a private chat. Membership and the per-user
--       columns (archivedBy/mutedBy/pinnedBy/acceptedBy/
--       mutedUntil) are now delta-checked; identity columns and
--       typing are pinned.
--   M3  messages_update pinned only senderId/participants/text —
--       a chat partner could unsend YOUR messages, swap your file
--       URLs, forge readBy or rewrite chat-poll votes. Every
--       mutable column now carries its own flow-shaped guard;
--       conversationId is pinned too (it was movable).
--   M4  events_update_rsvp left going/interested unpinned —
--       anyone could forge or remove other people's RSVPs. Each
--       list now carries the ±-caller delta.
--
-- The delta checks live in the small immutable helper functions in
-- section 1 (pure jsonb transforms of old/new values — the same
-- ±-caller-uid idea the followers/story-views policies already use
-- inline, generalised to reactions maps, poll votes and nested
-- comment replies).
--
-- WHAT DOES NOT CHANGE: admins keep full update rights through the
-- separate admin branches (posts_update_admin, users_update_
-- superadmin, ...); the bot runner and instant responder sign in
-- as the admin account, so bot likes/comments/profile syncs ride
-- those branches exactly as before. No app code changes are needed
-- for this file — the companion app-side fix (fresh-read before
-- engagement writes, audit M5) ships in the same commit so the
-- client computes its whole-array writes from fresh rows and the
-- delta checks accept them.
--
-- ROLLBACK: re-run the previous policy definitions from git
-- history (the commit before this fix) — or, per policy, DROP the
-- policy and recreate the WITH CHECK (true) / unpinned form quoted
-- in CODE-AUDIT.md. There is no data migration to undo.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Delta helper functions (identical to supabase/policies.sql)
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

create or replace function public.uid_map_delta_ok(p_old jsonb, p_new jsonb, p_uid text)
returns boolean
language sql immutable set search_path = public as $$
  select (coalesce(p_new, '{}'::jsonb) - p_uid)
           = (coalesce(p_old, '{}'::jsonb) - p_uid)
$$;
revoke execute on function public.uid_map_delta_ok(jsonb, jsonb, text) from public, anon;
grant execute on function public.uid_map_delta_ok(jsonb, jsonb, text) to authenticated;

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
-- ---------------------------------------------------------------------
-- 2. Hardened policies (identical to supabase/policies.sql)
-- ---------------------------------------------------------------------
drop policy if exists users_update_self_admin on public.users;
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

drop policy if exists posts_update_author on public.posts;
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

drop policy if exists posts_update_engagement on public.posts;
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

drop policy if exists stories_update_author_admin on public.stories;
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

drop policy if exists groups_update_admin_creator on public.groups;
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

drop policy if exists events_update_admin_creator on public.events;
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

drop policy if exists events_update_rsvp on public.events;
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

drop policy if exists conversations_update_participant on public.conversations;
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

drop policy if exists messages_update on public.messages;
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
commit;

-- =====================================================================
-- VERIFICATION (run AFTER applying; all in the dashboard SQL Editor
-- unless noted):
--
-- A. The nine policies exist with the new checks:
--      select polname, pg_get_expr(polwithcheck, polrelid) is not null
--        as has_check
--      from pg_policy
--      where polname in ('users_update_self_admin',
--        'posts_update_author', 'posts_update_engagement',
--        'stories_update_author_admin', 'groups_update_admin_creator',
--        'events_update_admin_creator', 'events_update_rsvp',
--        'conversations_update_participant', 'messages_update')
--      order by polname;
--    -> expect 9 rows, has_check = true for all.
--
-- B. The delta helpers exist:
--      select proname from pg_proc
--      where proname in ('jsonb_uid_count', 'jsonb_list_without_uid',
--        'uid_list_delta_ok', 'uid_list_add_ok', 'uid_map_delta_ok',
--        'post_poll_delta_ok', 'chat_poll_without_voter',
--        'chat_poll_delta_ok', 'msg_reactions_without_user',
--        'msg_reactions_delta_ok', 'replies_delta_ok',
--        'comments_delta_ok')
--      order by proname;
--    -> expect 12 rows.
--
-- C. Behaviour probes (curl with the publishable key; get a NORMAL
--    user token, e.g. MeetBook Test, from POST /auth/v1/token):
--    1. Self-unban must FAIL (H1): as a normal user, PATCH
--       /rest/v1/users?id=eq.<own id>  {"status":"banned"} is not
--       the test — use {"verified":true}:
--       -> expect HTTP 403 (42501) or 0 rows updated; the row's
--          verified stays false. (Before the fix: 200, verified
--          flipped.)
--    2. Comment wipe must FAIL (H2): PATCH /rest/v1/posts?id=eq.
--       <any post id>  {"comments":[]}
--       -> expect HTTP 403 (42501); comments unchanged. (Before:
--          200 and every comment gone.)
--    3. Own like must still WORK (H2): PATCH the same post with
--       {"likes":[<existing likes...>, "<own uid>"]} computed from
--       the CURRENT row -> expect 200 and the like present. Then
--       remove it the same way -> 200.
--    4. RSVP forgery must FAIL (M4): PATCH /rest/v1/events?id=eq.
--       <event id> with going = current list PLUS someone else's
--       uid -> expect 403. Adding your OWN uid -> 200.
--    5. Partner censorship must FAIL (M3): as one side of a DM,
--       PATCH /rest/v1/messages?id=eq.<partner's message id>
--       {"unsent":true} -> expect 403 / 0 rows.
--    6. App smoke test: sign in on the live site, like a post,
--       comment, save, vote in a poll, RSVP to the event, send and
--       react to a message, pin a message, mark a chat read —
--       every action must succeed exactly as before.
-- =====================================================================
