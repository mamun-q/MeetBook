-- =====================================================================
-- fix-leave-rpc-2026-11-25.sql — leave_conversation / leave_group RPCs
-- STATUS: READY TO APPLY — paste this WHOLE file into the Supabase
-- dashboard SQL Editor and Run it once (steps at the bottom). It is
-- idempotent: both functions are CREATE OR REPLACE, so running it
-- twice is harmless.
--
-- WHAT IT FIXES (pre-existing bug, flagged by the 2026-11-25 audit
-- and documented in the M2 comment inside supabase/policies.sql):
-- leaving a group chat fails live with Postgres error 42501. The
-- conversations UPDATE policy (conversations_update_participant)
-- already permits a member removing exactly themselves, but
-- Postgres rejects ANY update whose NEW row the updater cannot see
-- under the SELECT policy — and a departed member is no longer in
-- participants, so conversations_select hides the row from them.
-- The policy layer cannot lift that wall; a SECURITY DEFINER
-- function can, because it runs as the table owner and bypasses
-- RLS. This is the same remedy pattern as join_via_invite()
-- (supabase/join_via_invite.sql), the mirror image of this fix.
--
-- The same trap exists for leaving a PRIVATE group: groups_select
-- shows a private group only to members/creator/admins, so a member
-- removing themselves makes the updated row invisible and the
-- direct UPDATE dies the same way. (PUBLIC groups stay visible
-- after leaving, so their leave keeps the direct update in the
-- client — leave_group exists for the private case, and is safe
-- for either.)
--
-- THE RULES ENCODED — mirrored from the client flows in src/api.js,
-- which remain the first line of defence; these functions are the
-- guarantee on the RPC path:
--   leave_conversation(p_conversation_id):
--     * caller must be signed in (auth.uid());
--     * the conversation must exist and be a GROUP chat — the UI
--       offers Leave only on group chats (leaveGroupConversation /
--       removeGroupChatMember reject non-group conversations); 1-1
--       chats cannot be left;
--     * the caller must currently be a participant — calling when
--       not a member (including a second call after leaving) is a
--       clean error and changes nothing;
--     * the >= 2 floor from removeGroupChatMember: a group chat
--       keeps at least two participants ('A group needs at least
--       two members.');
--     * NO creator restriction: removeGroupChatMember lets any
--       participant remove themselves, the chat creator included
--       (unlike groups, below);
--     * the ONLY change ever made is removing the caller's own uid
--       — the function takes no target-uid parameter, so it cannot
--       be used to remove anyone else.
--   leave_group(p_group_id):
--     * caller must be signed in;
--     * the group must exist;
--     * the creator can NEVER leave their own group —
--       toggleGroupMembership (src/api.js) refuses with 'Group
--       creators cannot leave their own group — delete the group
--       instead.' and the RPC enforces the same rule server-side;
--     * the caller must currently be in members — a non-member call
--       (or a repeat call) is a clean error, no change;
--     * NO members floor: toggleGroupMembership has none for groups
--       (a group may drop to just its creator);
--     * the ONLY change is removing the caller's own uid.
--   Both return the NEW participants/members array so the client
--   can mirror the result immediately.
--
-- WHAT DOES NOT CHANGE: no policy is touched. Creator/admin
-- removing SOMEONE ELSE keeps the existing direct-update path
-- (their updated row stays visible to them, so it never hit the
-- trap). Joining, requesting and every other flow are untouched.
-- =====================================================================

begin;

create or replace function public.leave_conversation(p_conversation_id text)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  text := (select auth.uid())::text;
  v_conv public.conversations;
  v_next text[];
begin
  if v_uid is null then
    raise exception 'leave_conversation: caller is not signed in';
  end if;

  select * into v_conv from public.conversations
   where id = p_conversation_id;
  if not found then
    raise exception 'leave_conversation: conversation not found';
  end if;

  if not v_conv."isGroup" then
    raise exception 'leave_conversation: only group chats can be left';
  end if;

  if not (v_uid = any (v_conv.participants)) then
    raise exception 'leave_conversation: caller is not a participant';
  end if;

  v_next := array_remove(v_conv.participants, v_uid);
  if cardinality(v_next) < 2 then
    raise exception 'leave_conversation: a group needs at least two members';
  end if;

  update public.conversations
     set participants = v_next
   where id = v_conv.id;

  return v_next;
end;
$$;

revoke execute on function public.leave_conversation(text) from public, anon;
grant execute on function public.leave_conversation(text) to authenticated;

create or replace function public.leave_group(p_group_id text)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   text := (select auth.uid())::text;
  v_group public.groups;
  v_next  text[];
begin
  if v_uid is null then
    raise exception 'leave_group: caller is not signed in';
  end if;

  select * into v_group from public.groups
   where id = p_group_id;
  if not found then
    raise exception 'leave_group: group not found';
  end if;

  if v_group."createdBy" = v_uid then
    raise exception 'leave_group: group creators cannot leave their own group — delete the group instead';
  end if;

  if not (v_uid = any (v_group.members)) then
    raise exception 'leave_group: caller is not a member';
  end if;

  v_next := array_remove(v_group.members, v_uid);

  update public.groups
     set members = v_next
   where id = v_group.id;

  return v_next;
end;
$$;

revoke execute on function public.leave_group(text) from public, anon;
grant execute on function public.leave_group(text) to authenticated;

commit;

-- =====================================================================
-- APPLY STEPS (dashboard SQL Editor):
--   1. Supabase dashboard -> MeetBook project -> SQL Editor ->
--      New query -> paste this WHOLE file -> Run.
--      Expect "Success. No rows returned".
--   2. Run the VERIFICATION queries below the same way.
--   3. App smoke test: sign in on the live site, open a group chat
--      you belong to and Leave it (it must succeed and disappear
--      from your list); leave a PRIVATE group you belong to (must
--      succeed); try leaving a 2-person group chat (must be refused
--      with 'A group needs at least two members.').
--
-- VERIFICATION (run AFTER applying; all in the dashboard SQL Editor
-- unless noted):
--
-- A. Both functions exist and are SECURITY DEFINER:
--      select proname, prosecdef from pg_proc
--      where proname in ('leave_conversation', 'leave_group')
--      order by proname;
--    -> expect 2 rows, prosecdef = true for both.
--
-- B. Execute is granted to authenticated only:
--      select proname,
--        has_function_privilege('authenticated', oid, 'execute')
--          as auth_can_execute,
--        has_function_privilege('anon', oid, 'execute')
--          as anon_can_execute
--      from pg_proc
--      where proname in ('leave_conversation', 'leave_group')
--      order by proname;
--    -> expect 2 rows, auth_can_execute = true and
--       anon_can_execute = false for both.
--
-- C. Behaviour probes (as a signed-in NORMAL user, e.g. via the
--    app itself or PostgREST POST /rest/v1/rpc/leave_conversation
--    with {"p_conversation_id": "<a group chat id you belong to>"}):
--    1. Member leaves a 3+ person group chat -> 200, the returned
--       array is the old participants minus exactly your uid.
--    2. Call again for the same chat -> error 'caller is not a
--       participant', nothing changes.
--    3. Call for a 2-person group chat -> error 'a group needs at
--       least two members', nothing changes.
--    4. POST /rest/v1/rpc/leave_group for a private group you
--       belong to -> 200, members shrunk by exactly your uid; as
--       the group's creator -> error 'group creators cannot leave
--       their own group'.
-- =====================================================================
