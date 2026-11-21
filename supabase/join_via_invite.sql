-- =====================================================================
-- MeetBook — join_via_invite(p_code) RPC (Phase 2 remedy)
--
-- The applied RLS policy conversations_update_self_join cannot work
-- for a NON-participant joiner: Postgres applies RLS to the policy's
-- own self-lookup subqueries too, so for someone outside the
-- conversation every pin comparison reads a row they may not see and
-- goes null (see the KNOWN ISSUE comment in policies.sql). This
-- SECURITY DEFINER function is the remedy, in the same pattern as
-- file_appeal() / accept_friendship(): it runs as the table owner,
-- bypasses RLS, and its internal checks are therefore the whole
-- guarantee on this path:
--   (a) the caller must be signed in;
--   (b) the invite code must exist (invites.id IS the code);
--   (c) the conversation it points at must exist;
--   (d) the ONLY change ever made is appending the caller's own uid
--       to that conversation's participants, and only if absent —
--       re-joining is a no-op success, mirroring the client behaviour
--       the Firestore self-join branch produced.
-- Returns the conversation id either way.
--
-- NOT applied live yet — Muse applies this with the Phase 2 batch.
-- =====================================================================

begin;

create or replace function public.join_via_invite(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    text := (select auth.uid())::text;
  v_invite public.invites;
  v_conv   public.conversations;
begin
  if v_uid is null then
    raise exception 'join_via_invite: caller is not signed in';
  end if;

  select * into v_invite from public.invites where id = p_code;
  if not found then
    raise exception 'join_via_invite: invite code not found';
  end if;

  select * into v_conv from public.conversations
   where id = v_invite."conversationId";
  if not found then
    raise exception 'join_via_invite: conversation not found';
  end if;

  if v_uid = any (v_conv.participants) then
    return v_conv.id;  -- already a member: no-op success
  end if;

  update public.conversations
     set participants = array_append(participants, v_uid)
   where id = v_conv.id;

  return v_conv.id;
end;
$$;

revoke execute on function public.join_via_invite(text) from public, anon;
grant execute on function public.join_via_invite(text) to authenticated;

commit;
