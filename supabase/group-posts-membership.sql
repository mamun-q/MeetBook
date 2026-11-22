-- =====================================================================
-- group-posts-membership.sql — group posts follow CURRENT membership
--
-- BUG (proven live, 2026-11-22 browser E2E): a private group's
-- existing posts were invisible to a member who joined later, and
-- stayed visible (at the SQL level) to a member who had been
-- removed. Both directions came from the same root: reads keyed off
-- the post's stored audienceIds, which snapshot the group's member
-- list at post-creation time and never move again.
--
-- FIX: posts_select gains a read-time group branch — a group post is
-- readable when the group is non-private, or the caller is a CURRENT
-- member of the group, or the caller created the group. The
-- audienceIds branch is simultaneously restricted to non-group
-- posts, so the stale snapshot can no longer grant a former member
-- SQL-level access to group posts. (Friends/close-friends posts have
-- groupId = '' and keep the audience branch unchanged; public-group
-- posts are stored visibility='public' and were already readable.)
--
-- The subquery reads public.groups under its own SELECT policy,
-- which never references posts — no policy recursion (the same
-- exists-subquery shape posts_insert already uses).
--
-- NO DATA REPAIR NEEDED: the rule is evaluated at read time, so
-- existing rows behave correctly the moment this lands. The stored
-- audienceIds on group posts simply becomes inert.
--
-- Side effect, intended: engagement (like/comment via
-- posts_update_engagement, whose self-lookups are filtered by
-- posts_select) follows the same rule — new members can engage with
-- older group posts; former members no longer can.
--
-- Apply in the Supabase SQL editor. Idempotent: the policy is
-- dropped and recreated with the canonical definition (kept in sync
-- with supabase/policies.sql).
-- =====================================================================

drop policy if exists posts_select on public.posts;

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
