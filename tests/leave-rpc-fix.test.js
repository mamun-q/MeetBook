// Leave fix 2026-11-25 (pre-existing 42501 trap) — pins:
//  A. The standalone apply file supabase/fix-leave-rpc-2026-11-25.sql
//     defines leave_conversation / leave_group as SECURITY DEFINER
//     functions that remove ONLY the caller (auth.uid()), take no
//     target-uid parameter, check membership first, and are granted
//     to authenticated only. The rules mirror src/api.js: group
//     chats only + >=2 floor for conversations; creator can never
//     leave + no floor for groups.
//  B. Source pins: the client leave paths call the RPCs through
//     sbRpc (self-leave in removeGroupChatMember; private-group
//     leave in toggleGroupMembership), while the paths that never
//     hit the trap (creator removing others, public-group leave)
//     keep their direct fresh-read writes.
//  C. Behaviour on the fake-supabase harness (whose rpc() mirrors
//     the SQL): leaving works, the floor and the creator rule bite,
//     and a MISSING RPC (pre-SQL world, via fake.failRpc) surfaces
//     as a normal rejected promise — no crash, no state change.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../src/supabase.js', async () => {
  const fake = await import('./fake-supabase.js');
  return {
    supabaseReady: true, isSupabaseConfigured: true,
    supabaseConfig: { url: 'https://fake.supabase.co', publishableKey: 'fake', projectRef: 'fake' },
    supabase: fake.fakeClient
  };
});

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.document = { dispatchEvent: () => true };

// ---------------------------------------------------------------- A: SQL
const applySql = readFileSync(new URL('../supabase/fix-leave-rpc-2026-11-25.sql', import.meta.url), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function fnChunk(sql, name) {
  const i = sql.indexOf(`create or replace function public.${name}(`);
  if (i < 0) return null;
  const g = sql.indexOf(`grant execute on function public.${name}`, i);
  if (g < 0) return null;
  const j = sql.indexOf('to authenticated;', g);
  return norm(sql.slice(i, j + 'to authenticated;'.length));
}

describe('A: leave RPC apply file', () => {
  it('is transactional and header-documented', () => {
    expect(applySql).toContain('begin;');
    expect(applySql).toContain('commit;');
    expect(applySql).toContain('VERIFICATION');
    expect(applySql).toContain('42501');
  });
  it('neither function accepts a target-uid parameter', () => {
    expect(applySql).toContain('create or replace function public.leave_conversation(p_conversation_id text)');
    expect(applySql).toContain('create or replace function public.leave_group(p_group_id text)');
    expect(applySql).not.toMatch(/p_(uid|user|member|target|other)/);
  });
  for (const name of ['leave_conversation', 'leave_group']) {
    it(`${name} is SECURITY DEFINER, caller-only, authenticated-only`, () => {
      const c = fnChunk(applySql, name);
      expect(c, `function missing from apply file: ${name}`).toBeTruthy();
      expect(c).toContain('security definer');
      expect(c).toContain('set search_path = public');
      expect(c).toContain('(select auth.uid())::text');
      expect(c).toContain('caller is not signed in');
      expect(c).toContain(`revoke execute on function public.${name}(text) from public, anon`);
      expect(c).toContain(`grant execute on function public.${name}(text) to authenticated`);
    });
  }
  it('leave_conversation: group chats only, participant check, >=2 floor, removes only v_uid', () => {
    const c = fnChunk(applySql, 'leave_conversation');
    expect(c).toContain('"isGroup"');
    expect(c).toContain('only group chats can be left');
    expect(c).toContain('caller is not a participant');
    expect(c).toContain('array_remove(v_conv.participants, v_uid)');
    expect(c).toContain('cardinality(v_next) < 2');
    expect(c).toContain('a group needs at least two members');
  });
  it('leave_group: creator refused, member check, removes only v_uid, NO floor', () => {
    const c = fnChunk(applySql, 'leave_group');
    expect(c).toContain('"createdBy"');
    expect(c).toContain('group creators cannot leave their own group');
    expect(c).toContain('caller is not a member');
    expect(c).toContain('array_remove(v_group.members, v_uid)');
    expect(c).not.toContain('cardinality');
  });
});

// ------------------------------------------------------- B: source pins
const apiSrc = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
function fnBody(name) {
  const i = apiSrc.indexOf(`export async function ${name}(`);
  if (i < 0) return null;
  const j = apiSrc.indexOf('\nexport ', i + 10);
  return apiSrc.slice(i, j < 0 ? undefined : j);
}

describe('B: client leave paths call the RPCs', () => {
  it('removeGroupChatMember routes SELF-leave through leave_conversation', () => {
    const body = fnBody('removeGroupChatMember');
    expect(body).toBeTruthy();
    expect(body).toContain("sbRpc('leave_conversation', { p_conversation_id: conversationId })");
    expect(body).toContain('isSelf');
    // The creator/admin removing OTHERS keeps the direct write.
    expect(body).toContain('patchConversationFields');
  });
  it('toggleGroupMembership routes PRIVATE-group leave through leave_group', () => {
    const body = fnBody('toggleGroupMembership');
    expect(body).toBeTruthy();
    expect(body).toContain("sbRpc('leave_group', { p_group_id: groupId })");
    expect(body).toContain("group.privacy === 'private'");
    // Public join/leave keeps the direct fresh-read write.
    expect(body).toContain("sbUpdate('groups'");
  });
  it('leaveGroupConversation still delegates to removeGroupChatMember', () => {
    const body = fnBody('leaveGroupConversation');
    expect(body).toBeTruthy();
    expect(body).toContain('removeGroupChatMember(conversationId');
  });
});

// ------------------------------------------------- C: behaviour (live)
let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const HUMAN = (name, username) => ({
  name, username, email: `${username}@example.com`, role: 'user', isBot: false,
  followers: [], following: [], closeFriends: [], settings: {}, createdAt: 1700000000000
});
const CONV = {
  participants: ['human1', 'human2'], isGroup: false, createdBy: 'human1', title: '',
  theme: null, emoji: null, nicknames: {}, typing: {}, archivedBy: [], mutedBy: [],
  pinnedBy: [], acceptedBy: ['human1', 'human2'], mutedUntil: {}, vanish: false,
  joinCode: '', createdAt: 1700000000000
};
const GROUP = {
  name: 'Club', description: '', privacy: 'public', cover: '',
  createdBy: 'human2', members: ['human2'], createdAt: 1700000000000
};

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'hasan@example.com': 'human1', 'ayesha@example.com': 'human2', 'tanvir@example.com': 'human3' };
  fake.seed('users', 'human1', HUMAN('Hasan Human', 'hasan'));
  fake.seed('users', 'human2', HUMAN('Ayesha Khan', 'ayesha'));
  fake.seed('users', 'human3', HUMAN('Tanvir Ahmed', 'tanvir'));
  // Group chats: a 3-person one to leave, a 2-person one for the
  // floor, one where human1 is the creator (removing others), one
  // for the missing-RPC probe.
  fake.seed('conversations', 'gleave', { ...CONV, isGroup: true, createdBy: 'human2', title: 'Leave GC', participants: ['human1', 'human2', 'human3'] });
  fake.seed('conversations', 'gleave2', { ...CONV, isGroup: true, createdBy: 'human2', title: 'Pair GC', participants: ['human1', 'human2'] });
  fake.seed('conversations', 'gleave3', { ...CONV, isGroup: true, createdBy: 'human1', title: 'Mine GC', participants: ['human1', 'human2', 'human3'] });
  fake.seed('conversations', 'gleave4', { ...CONV, isGroup: true, createdBy: 'human2', title: 'PreSQL GC', participants: ['human1', 'human2', 'human3'] });
  // Groups: a private one human1 belongs to, a public one, and one
  // human1 created.
  fake.seed('groups', 'gpriv', { ...GROUP, name: 'Secret Club', privacy: 'private', members: ['human2', 'human1'] });
  fake.seed('groups', 'gpub', { ...GROUP, name: 'Open Club', privacy: 'public', members: ['human2', 'human1'] });
  fake.seed('groups', 'gown', { ...GROUP, name: 'My Club', privacy: 'public', createdBy: 'human1', members: ['human1', 'human2'] });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('hasan@example.com', 'whatever');
  await settle();
});

describe('C: leave behaviour on the fake harness', () => {
  it('leaving a group chat removes exactly the caller', async () => {
    const next = await api.leaveGroupConversation('gleave');
    expect(next).toEqual(['human2', 'human3']);
    expect(fake.get('conversations', 'gleave').participants).toEqual(['human2', 'human3']);
  });

  it('the >=2 floor refuses leaving a 2-person group chat, changing nothing', async () => {
    await expect(api.leaveGroupConversation('gleave2')).rejects.toThrow(/at least two members/);
    expect(fake.get('conversations', 'gleave2').participants).toEqual(['human1', 'human2']);
  });

  it('a missing RPC (pre-SQL) surfaces as a normal error, changing nothing', async () => {
    fake.failRpc('leave_conversation');
    try {
      await expect(api.leaveGroupConversation('gleave4')).rejects.toThrow(/leave_conversation/);
    } finally {
      fake.clearRpcFailures();
    }
    expect(fake.get('conversations', 'gleave4').participants).toEqual(['human1', 'human2', 'human3']);
  });

  it('the chat creator removing SOMEONE ELSE still uses the direct write', async () => {
    const next = await api.removeGroupChatMember('gleave3', 'human3');
    expect(next).toEqual(['human1', 'human2']);
    expect(fake.get('conversations', 'gleave3').participants).toEqual(['human1', 'human2']);
  });

  it('leaving a PRIVATE group removes exactly the caller (RPC path)', async () => {
    const result = await api.toggleGroupMembership('gpriv');
    expect(result).toBe('left');
    expect(fake.get('groups', 'gpriv').members).toEqual(['human2']);
  });

  it('leaving a PUBLIC group still works (direct path)', async () => {
    const result = await api.toggleGroupMembership('gpub');
    expect(result).toBe('left');
    expect(fake.get('groups', 'gpub').members).toEqual(['human2']);
  });

  it('a group creator still cannot leave their own group', async () => {
    await expect(api.toggleGroupMembership('gown')).rejects.toThrow(/Group creators cannot leave/);
    expect(fake.get('groups', 'gown').members).toEqual(['human1', 'human2']);
  });
});
