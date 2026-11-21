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
--    (posts author, stories author, groups creator, pages owner,
--    events creator, notifications owner, conversation participants)
--    the policy carries an explicit `with check (true)`. Omitting
--    WITH CHECK would silently impose USING on the new row too and
--    narrow the guarantee (e.g. a participant could never remove
--    themselves from a conversation). Role-based branches
--    (admin/moderator/superadmin) repeat their predicate in
--    WITH CHECK instead, which is equivalent and self-documenting.
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
-- updates by self/admin with role+isBot pinned (superadmin unpinned),
-- plus a followers-only branch where anyone may add/remove exactly
-- their own uid; delete by self or admin.
-- (Carried-over exposure, mirrored 1:1: email/status are readable by
-- every signed-in user, exactly as in Firestore — see RLS_NOTES.md.)
-- =====================================================================
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
          (select o.role from public.users o where o.id = users.id)
    and "isBot" is not distinct from
          (select o."isBot" from public.users o where o.id = users.id)
  );

-- Followers-only branch: every column except `followers` pinned via
-- self-lookup; the followers delta is exactly + or − the caller's uid
-- (length ±1, containment both ways, caller-membership flips).
create policy users_update_followers on public.users
  for update to authenticated
  using (id <> (select auth.uid())::text)
  with check (
    name is not distinct from
      (select o.name from public.users o where o.id = users.id)
    and username is not distinct from
      (select o.username from public.users o where o.id = users.id)
    and email is not distinct from
      (select o.email from public.users o where o.id = users.id)
    and bio is not distinct from
      (select o.bio from public.users o where o.id = users.id)
    and avatar is not distinct from
      (select o.avatar from public.users o where o.id = users.id)
    and cover is not distinct from
      (select o.cover from public.users o where o.id = users.id)
    and work is not distinct from
      (select o.work from public.users o where o.id = users.id)
    and education is not distinct from
      (select o.education from public.users o where o.id = users.id)
    and "currentCity" is not distinct from
      (select o."currentCity" from public.users o where o.id = users.id)
    and hometown is not distinct from
      (select o.hometown from public.users o where o.id = users.id)
    and relationship is not distinct from
      (select o.relationship from public.users o where o.id = users.id)
    and website is not distinct from
      (select o.website from public.users o where o.id = users.id)
    and nickname is not distinct from
      (select o.nickname from public.users o where o.id = users.id)
    and dob is not distinct from
      (select o.dob from public.users o where o.id = users.id)
    and gender is not distinct from
      (select o.gender from public.users o where o.id = users.id)
    and role is not distinct from
      (select o.role from public.users o where o.id = users.id)
    and "isBot" is not distinct from
      (select o."isBot" from public.users o where o.id = users.id)
    and "botId" is not distinct from
      (select o."botId" from public.users o where o.id = users.id)
    and status is not distinct from
      (select o.status from public.users o where o.id = users.id)
    and verified is not distinct from
      (select o.verified from public.users o where o.id = users.id)
    and online is not distinct from
      (select o.online from public.users o where o.id = users.id)
    and "lastSeen" is not distinct from
      (select o."lastSeen" from public.users o where o.id = users.id)
    and "createdAt" is not distinct from
      (select o."createdAt" from public.users o where o.id = users.id)
    and following is not distinct from
      (select o.following from public.users o where o.id = users.id)
    and "closeFriends" is not distinct from
      (select o."closeFriends" from public.users o where o.id = users.id)
    and settings is not distinct from
      (select o.settings from public.users o where o.id = users.id)
    and (
      ( -- follow: append exactly the caller's uid
        jsonb_array_length(followers)
          = jsonb_array_length((select o.followers from public.users o where o.id = users.id)) + 1
        and followers @> (select o.followers from public.users o where o.id = users.id)
        and followers @> jsonb_build_array((select auth.uid())::text)
        and not ((select o.followers from public.users o where o.id = users.id)
                 @> jsonb_build_array((select auth.uid())::text))
      )
      or
      ( -- unfollow: remove exactly the caller's uid
        jsonb_array_length(followers)
          = jsonb_array_length((select o.followers from public.users o where o.id = users.id)) - 1
        and (select o.followers from public.users o where o.id = users.id) @> followers
        and (select o.followers from public.users o where o.id = users.id)
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
-- or uid ∈ audienceIds; create by an active writer with likes empty,
-- as self (group posts only if a member of that group), or by an
-- admin as a bot (plain feed only — no group/page posts); update by
-- admin, by author, or by any signed-in user with authorship/text/
-- image/visibility/group/page/audience all pinned (engagement only);
-- delete by author or admin.
-- =====================================================================
create policy posts_select on public.posts
  for select to authenticated
  using (
    "authorId" = (select auth.uid())::text
    or public.is_admin()
    or visibility = 'public'
    or (select auth.uid())::text = any ("audienceIds")
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

-- Firestore's author branch pins nothing (see header convention).
create policy posts_update_author on public.posts
  for update to authenticated
  using ("authorId" = (select auth.uid())::text)
  with check (true);

-- Engagement branch. NOTE (RLS_NOTES.md summary #5): the pin
-- self-lookups are filtered by posts_select, so engagement
-- effectively requires the post to be readable by the caller —
-- Firestore allowed engaging with an unreadable post by id. Safe
-- direction; no real flow changes (clients engage with loaded posts).
create policy posts_update_engagement on public.posts
  for update to authenticated
  using (true)
  with check (
    "authorId" is not distinct from
      (select o."authorId" from public.posts o where o.id = posts.id)
    and text is not distinct from
      (select o.text from public.posts o where o.id = posts.id)
    and image is not distinct from
      (select o.image from public.posts o where o.id = posts.id)
    and visibility is not distinct from
      (select o.visibility from public.posts o where o.id = posts.id)
    and "groupId" is not distinct from
      (select o."groupId" from public.posts o where o.id = posts.id)
    and "pageId" is not distinct from
      (select o."pageId" from public.posts o where o.id = posts.id)
    and "audienceIds" is not distinct from
      (select o."audienceIds" from public.posts o where o.id = posts.id)
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

create policy stories_update_author_admin on public.stories
  for update to authenticated
  using ("authorId" = (select auth.uid())::text or public.is_admin())
  with check (true);

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
      (select o."authorId" from public.stories o where o.id = stories.id)
    and image is not distinct from
      (select o.image from public.stories o where o.id = stories.id)
    and text is not distinct from
      (select o.text from public.stories o where o.id = stories.id)
    and bg is not distinct from
      (select o.bg from public.stories o where o.id = stories.id)
    and visibility is not distinct from
      (select o.visibility from public.stories o where o.id = stories.id)
    and "audienceIds" is not distinct from
      (select o."audienceIds" from public.stories o where o.id = stories.id)
    and "createdAt" is not distinct from
      (select o."createdAt" from public.stories o where o.id = stories.id)
    and jsonb_array_length(views)
          = jsonb_array_length((select o.views from public.stories o where o.id = stories.id)) + 1
    and views @> (select o.views from public.stories o where o.id = stories.id)
    and views @> jsonb_build_array((select auth.uid())::text)
    and not ((select o.views from public.stories o where o.id = stories.id)
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

create policy groups_update_admin_creator on public.groups
  for update to authenticated
  using (public.is_admin() or "createdBy" = (select auth.uid())::text)
  with check (true);

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
      (select o.name from public.groups o where o.id = groups.id)
    and description is not distinct from
      (select o.description from public.groups o where o.id = groups.id)
    and privacy is not distinct from
      (select o.privacy from public.groups o where o.id = groups.id)
    and cover is not distinct from
      (select o.cover from public.groups o where o.id = groups.id)
    and "createdBy" is not distinct from
      (select o."createdBy" from public.groups o where o.id = groups.id)
    and "createdAt" is not distinct from
      (select o."createdAt" from public.groups o where o.id = groups.id)
    and (
      ( -- join: add exactly the caller's uid
        cardinality(members)
          = cardinality((select o.members from public.groups o where o.id = groups.id)) + 1
        and members @> (select o.members from public.groups o where o.id = groups.id)
        and (select auth.uid())::text = any (members)
        and not exists (
              select 1 from public.groups o
              where o.id = groups.id
                and (select auth.uid())::text = any (o.members))
      )
      or
      ( -- leave: remove exactly the caller's uid
        cardinality(members)
          = cardinality((select o.members from public.groups o where o.id = groups.id)) - 1
        and (select o.members from public.groups o where o.id = groups.id) @> members
        and exists (
              select 1 from public.groups o
              where o.id = groups.id
                and (select auth.uid())::text = any (o.members))
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
      (select o."userId" from public."groupRequests" o where o.id = "groupRequests".id)
    and "groupId" is not distinct from
      (select o."groupId" from public."groupRequests" o where o.id = "groupRequests".id)
    and "groupOwnerId" is not distinct from
      (select o."groupOwnerId" from public."groupRequests" o where o.id = "groupRequests".id)
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
      (select o.name from public.pages o where o.id = pages.id)
    and category is not distinct from
      (select o.category from public.pages o where o.id = pages.id)
    and about is not distinct from
      (select o.about from public.pages o where o.id = pages.id)
    and avatar is not distinct from
      (select o.avatar from public.pages o where o.id = pages.id)
    and cover is not distinct from
      (select o.cover from public.pages o where o.id = pages.id)
    and "ownerId" is not distinct from
      (select o."ownerId" from public.pages o where o.id = pages.id)
    and "createdAt" is not distinct from
      (select o."createdAt" from public.pages o where o.id = pages.id)
    and (
      ( -- follow: append exactly the caller's uid
        jsonb_array_length(followers)
          = jsonb_array_length((select o.followers from public.pages o where o.id = pages.id)) + 1
        and followers @> (select o.followers from public.pages o where o.id = pages.id)
        and followers @> jsonb_build_array((select auth.uid())::text)
        and not ((select o.followers from public.pages o where o.id = pages.id)
                 @> jsonb_build_array((select auth.uid())::text))
      )
      or
      ( -- unfollow: remove exactly the caller's uid
        jsonb_array_length(followers)
          = jsonb_array_length((select o.followers from public.pages o where o.id = pages.id)) - 1
        and (select o.followers from public.pages o where o.id = pages.id) @> followers
        and (select o.followers from public.pages o where o.id = pages.id)
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
      (select o."authorId" from public.reviews o where o.id = reviews.id)
    and "pageId" is not distinct from
      (select o."pageId" from public.reviews o where o.id = reviews.id)
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

create policy events_update_admin_creator on public.events
  for update to authenticated
  using (public.is_admin() or "createdBy" = (select auth.uid())::text)
  with check (true);

-- RSVP branch: content/audience fields pinned via self-lookup,
-- exactly the set firestore.rules pins. (The pin self-lookups are
-- filtered by events_select — same safe-direction narrowing as posts
-- engagement, summary #5; clients RSVP on events they have loaded.)
create policy events_update_rsvp on public.events
  for update to authenticated
  using (true)
  with check (
    "createdBy" is not distinct from
      (select o."createdBy" from public.events o where o.id = events.id)
    and title is not distinct from
      (select o.title from public.events o where o.id = events.id)
    and description is not distinct from
      (select o.description from public.events o where o.id = events.id)
    and "dateTime" is not distinct from
      (select o."dateTime" from public.events o where o.id = events.id)
    and location is not distinct from
      (select o.location from public.events o where o.id = events.id)
    and cover is not distinct from
      (select o.cover from public.events o where o.id = events.id)
    and visibility is not distinct from
      (select o.visibility from public.events o where o.id = events.id)
    and "audienceIds" is not distinct from
      (select o."audienceIds" from public.events o where o.id = events.id)
  );

create policy events_delete on public.events
  for delete to authenticated
  using ("createdBy" = (select auth.uid())::text or public.is_admin());

-- =====================================================================
-- conversations
-- Guarantee: read by participants or admins; create with caller ∈
-- participants, ≥ 2 participants, group chats only with
-- createdBy = caller; update freely by participants — or by a
-- NON-participant adding exactly themselves to participants only,
-- when the conversation carries a joinCode backed by a live invites
-- doc; delete admin-only.
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

-- Participant branch: Firestore checks membership on the OLD row
-- only and leaves the new row unconstrained (participants manage
-- themes/typing/flags — and may remove themselves or others). The
-- explicit `with check (true)` reproduces that; omitting WITH CHECK
-- would impose the membership test on the NEW row and, among other
-- things, make leaving a conversation impossible.
create policy conversations_update_participant on public.conversations
  for update to authenticated
  using ((select auth.uid())::text = any (participants))
  with check (true);

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
          = cardinality((select o.participants from public.conversations o
                         where o.id = conversations.id)) + 1
    and participants @> (select o.participants from public.conversations o
                         where o.id = conversations.id)
    and "isGroup" is not distinct from
      (select o."isGroup" from public.conversations o where o.id = conversations.id)
    and title is not distinct from
      (select o.title from public.conversations o where o.id = conversations.id)
    and "createdBy" is not distinct from
      (select o."createdBy" from public.conversations o where o.id = conversations.id)
    and "createdAt" is not distinct from
      (select o."createdAt" from public.conversations o where o.id = conversations.id)
    and typing is not distinct from
      (select o.typing from public.conversations o where o.id = conversations.id)
    and theme is not distinct from
      (select o.theme from public.conversations o where o.id = conversations.id)
    and emoji is not distinct from
      (select o.emoji from public.conversations o where o.id = conversations.id)
    and nicknames is not distinct from
      (select o.nicknames from public.conversations o where o.id = conversations.id)
    and "archivedBy" is not distinct from
      (select o."archivedBy" from public.conversations o where o.id = conversations.id)
    and "mutedBy" is not distinct from
      (select o."mutedBy" from public.conversations o where o.id = conversations.id)
    and "pinnedBy" is not distinct from
      (select o."pinnedBy" from public.conversations o where o.id = conversations.id)
    and "acceptedBy" is not distinct from
      (select o."acceptedBy" from public.conversations o where o.id = conversations.id)
    and "mutedUntil" is not distinct from
      (select o."mutedUntil" from public.conversations o where o.id = conversations.id)
    and vanish is not distinct from
      (select o.vanish from public.conversations o where o.id = conversations.id)
    and "joinCode" is not distinct from
      (select o."joinCode" from public.conversations o where o.id = conversations.id)
    and (select o."joinCode" from public.conversations o where o.id = conversations.id) <> ''
    and exists (
      select 1 from public.invites i
      where i.id = (select o."joinCode" from public.conversations o
                    where o.id = conversations.id)
    )
  );

create policy conversations_delete on public.conversations
  for delete to authenticated
  using (public.is_admin());

-- =====================================================================
-- invites
-- Guarantee: any signed-in user may read a code (possession of the
-- code is the secret); create only by the conversation's creator,
-- for their own conversation; never update; delete by its creator.
-- =====================================================================
create policy invites_select on public.invites
  for select to authenticated
  using (true);

-- Note: the conversations subquery is filtered by
-- conversations_select; the conversation's creator is a participant
-- in every app flow, so it resolves. (Edge: a creator who was later
-- removed from the group could mint an invite in Firestore but not
-- here — narrowing in the safe direction.)
create policy invites_insert on public.invites
  for insert to authenticated
  with check (
    public.writer_status_ok()
    and "createdBy" = (select auth.uid())::text
    and (select c."createdBy" from public.conversations c
         where c.id = "conversationId") = (select auth.uid())::text
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
-- with the bot in both sets; update by any participant with senderId
-- and participants pinned and text changeable only by the sender;
-- delete admin-only.
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

create policy messages_update on public.messages
  for update to authenticated
  using ((select auth.uid())::text = any (participants))
  with check (
    "senderId" is not distinct from
      (select o."senderId" from public.messages o where o.id = messages.id)
    and participants is not distinct from
      (select o.participants from public.messages o where o.id = messages.id)
    and (
      text is not distinct from
        (select o.text from public.messages o where o.id = messages.id)
      or (select auth.uid())::text = "senderId"
    )
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
      (select o."from" from public.friendships o where o.id = friendships.id)
    and "to" is not distinct from
      (select o."to" from public.friendships o where o.id = friendships.id)
    and "createdAt" is not distinct from
      (select o."createdAt" from public.friendships o where o.id = friendships.id)
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
-- Guarantee: read by the owner or admins; create by ANY signed-in
-- user (actors notify each other — the app suppresses
-- self-notifications in createNotification); update by the owner;
-- delete by owner or admins.
-- =====================================================================
create policy notifications_select on public.notifications
  for select to authenticated
  using ("userId" = (select auth.uid())::text or public.is_admin());

-- FAITHFUL Firestore version: any signed-in user may create a
-- notification for anyone. This preserves Firestore's known
-- forge-any-notification hole 1:1 (RLS_NOTES.md, notifications flag).
create policy notifications_insert_faithful on public.notifications
  for insert to authenticated
  with check (true);

-- -------------------------------------------------------------------
-- OPTIONAL — needs Limon approval (Phase 2 decision)
-- Deliberate deviation recommended in RLS_NOTES.md: pin actorId to
-- the caller (admins exempt), closing the forgery hole. Every real
-- write path in api.js already sets actorId to the caller, so this
-- breaks nothing legitimate — but it IS a behaviour change. To
-- adopt: drop the faithful policy above and uncomment these two
-- statements.
--
-- drop policy notifications_insert_faithful on public.notifications;
-- create policy notifications_insert_actor_pinned on public.notifications
--   for insert to authenticated
--   with check (
--     "actorId" = (select auth.uid())::text
--     or public.is_admin()
--   );
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
