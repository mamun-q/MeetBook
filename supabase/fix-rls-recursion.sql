-- MeetBook RLS recursion fix — apply once in the SQL editor.
-- Creates SECURITY DEFINER row fetchers and recreates the 12
-- UPDATE policies whose pin subqueries referenced their own
-- table (Postgres: infinite recursion detected in policy).

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

drop policy users_update_self_admin on public."users";
create policy users_update_self_admin on public.users
  for update to authenticated
  using (id = (select auth.uid())::text or public.is_admin())
  with check (
    (id = (select auth.uid())::text or public.is_admin())
    and role is not distinct from
          ((public."users_row"(users.id)).role)
    and "isBot" is not distinct from
          ((public."users_row"(users.id))."isBot")
  );

drop policy users_update_followers on public."users";
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

drop policy posts_update_engagement on public."posts";
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
  );

drop policy stories_update_views on public."stories";
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

drop policy groups_update_self_membership on public."groups";
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

drop policy group_requests_update on public."groupRequests";
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

drop policy pages_update_followers on public."pages";
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

drop policy reviews_update on public."reviews";
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

drop policy events_update_rsvp on public."events";
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
  );

drop policy conversations_update_self_join on public."conversations";
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

drop policy messages_update on public."messages";
create policy messages_update on public.messages
  for update to authenticated
  using ((select auth.uid())::text = any (participants))
  with check (
    "senderId" is not distinct from
      ((public."messages_row"(messages.id))."senderId")
    and participants is not distinct from
      ((public."messages_row"(messages.id)).participants)
    and (
      text is not distinct from
        ((public."messages_row"(messages.id)).text)
      or (select auth.uid())::text = "senderId"
    )
  );

drop policy friendships_update_recipient_accept on public."friendships";
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
