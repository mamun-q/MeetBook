-- =====================================================================
-- MeetBook — group_discovery() RPC (private-group discovery)
--
-- Facebook-style discoverability: every group can be FOUND by any
-- signed-in user, but a private group's contents stay members-only.
-- The groups table's own SELECT policy must NOT be loosened to do
-- this — a groups row carries the full members array, so handing
-- rows to non-members would leak private member lists to anyone
-- holding the publishable key. This SECURITY DEFINER function is
-- the remedy, in the same pattern as file_appeal() /
-- accept_friendship() / join_via_invite(): it runs as the table
-- owner, bypasses RLS, and its projection is therefore the whole
-- guarantee on this path. It returns, per group, ONLY:
--   id, name, description, cover, privacy, "createdBy",
--   "createdAt", "memberCount" (cardinality of members).
-- The members array itself is never returned.
--
-- "createdBy" is included deliberately: the group creator is the
-- group's public admin (Facebook shows a private group's admins
-- too), and the client needs it to address a join request — the
-- groupRequests row denormalises groupOwnerId from it, and the
-- creator is notified. It identifies ONE person who
-- is already the group's public face; it exposes nothing about
-- the other members.
--
-- NOT applied live yet — Muse applies this with the discovery
-- batch. Until then the app's discovery fetch fails soft and the
-- groups mirror simply holds what the existing slices deliver.
-- =====================================================================

begin;

create or replace function public.group_discovery()
returns table (
  id          text,
  name        text,
  description text,
  cover       text,
  privacy     text,
  "createdBy" text,
  "createdAt" bigint,
  "memberCount" integer
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'group_discovery: caller is not signed in';
  end if;

  return query
    select
      g.id,
      g.name,
      g.description,
      g.cover,
      g.privacy,
      g."createdBy",
      g."createdAt",
      coalesce(cardinality(g.members), 0)
    from public.groups g
    order by g.id;
end;
$$;

revoke execute on function public.group_discovery() from public, anon;
grant execute on function public.group_discovery() to authenticated;

commit;
