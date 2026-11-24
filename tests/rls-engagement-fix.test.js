// Security fix pack 2026-11-25 (audit H1/H2/M1–M5) — pins:
//  A. The standalone apply file supabase/fix-rls-engagement-2026-11-25.sql
//     carries the SAME policy bodies and delta-helper definitions as
//     the source of truth supabase/policies.sql (they must never
//     drift), and the hardened fragments are present.
//  B. M5: every whole-array engagement writer in src/api.js re-reads
//     the stored row (sbGet) before computing its write — behavioural
//     tests on the fake-supabase harness: a concurrent change seeded
//     directly into the "database" (mirror left stale) must survive
//     the api write.
//  C. Source pins: each M5 function's body contains a fresh sbGet.
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
const policiesSql = readFileSync(new URL('../supabase/policies.sql', import.meta.url), 'utf8');
const applySql = readFileSync(new URL('../supabase/fix-rls-engagement-2026-11-25.sql', import.meta.url), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function policyChunk(sql, name) {
  const i = sql.indexOf(`create policy ${name} `);
  if (i < 0) return null;
  // Policies end with a newline + two-space `);` — do NOT cut at the
  // first ';' (inline comments inside a policy may contain one).
  const j = sql.indexOf('\n  );', i);
  if (j < 0) return null;
  return norm(sql.slice(i, j + '\n  );'.length));
}
function helperChunk(sql, name) {
  const i = sql.indexOf(`create or replace function public.${name}(`);
  if (i < 0) return null;
  const g = sql.indexOf(`grant execute on function public.${name}`, i);
  if (g < 0) return null;
  const j = sql.indexOf('to authenticated;', g);
  return norm(sql.slice(i, j + 'to authenticated;'.length));
}

const POLICIES = [
  'users_update_self_admin', 'posts_update_author', 'posts_update_engagement',
  'stories_update_author_admin', 'groups_update_admin_creator',
  'events_update_admin_creator', 'events_update_rsvp',
  'conversations_update_participant', 'messages_update'
];
const HELPERS = [
  'jsonb_uid_count', 'jsonb_list_without_uid', 'uid_list_delta_ok',
  'uid_list_add_ok', 'uid_map_delta_ok', 'post_poll_delta_ok',
  'chat_poll_without_voter', 'chat_poll_delta_ok',
  'msg_reactions_without_user', 'msg_reactions_delta_ok',
  'replies_delta_ok', 'comments_delta_ok'
];

describe('A: apply file cannot drift from policies.sql', () => {
  for (const name of POLICIES) {
    it(`policy ${name} is identical in both files`, () => {
      const a = policyChunk(policiesSql, name);
      const b = policyChunk(applySql, name);
      expect(a, `policy missing from policies.sql: ${name}`).toBeTruthy();
      expect(b, `policy missing from apply file: ${name}`).toBeTruthy();
      expect(b).toBe(a);
      expect(applySql).toContain(`drop policy if exists ${name} on public.`);
    });
  }
  for (const name of HELPERS) {
    it(`helper ${name} is identical in both files`, () => {
      const a = helperChunk(policiesSql, name);
      const b = helperChunk(applySql, name);
      expect(a, `helper missing from policies.sql: ${name}`).toBeTruthy();
      expect(b, `helper missing from apply file: ${name}`).toBeTruthy();
      expect(b).toBe(a);
    });
  }
  it('apply file is transactional and header-documented', () => {
    expect(applySql).toContain('begin;');
    expect(applySql).toContain('commit;');
    expect(applySql).toContain('VERIFICATION');
  });
  it('H1: users self-update pins status/verified to admin-on-others and pins followers', () => {
    const c = policyChunk(policiesSql, 'users_update_self_admin');
    expect(c).toContain('status');
    expect(c).toContain('verified');
    expect(c).toContain('followers');
    expect(c).toContain('public.is_admin()');
  });
  it('H2: posts engagement carries every delta helper', () => {
    const c = policyChunk(policiesSql, 'posts_update_engagement');
    for (const h of ['uid_list_delta_ok', 'uid_map_delta_ok', 'post_poll_delta_ok', 'comments_delta_ok']) {
      expect(c).toContain(h);
    }
  });
  it('M3: messages update pins conversationId and guards poll/reactions/readBy', () => {
    const c = policyChunk(policiesSql, 'messages_update');
    expect(c).toContain('"conversationId"');
    expect(c).toContain('chat_poll_delta_ok');
    expect(c).toContain('msg_reactions_delta_ok');
    expect(c).toContain('uid_list_add_ok');
  });
  it('M4: events RSVP delta-checks both lists', () => {
    const c = policyChunk(policiesSql, 'events_update_rsvp');
    expect((c.match(/uid_list_delta_ok/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  it('M2: conversations participant branch delta-checks membership and flags', () => {
    const c = policyChunk(policiesSql, 'conversations_update_participant');
    expect(c).toContain('uid_list_delta_ok');
    expect(c).toContain('jsonb_list_without_uid');
    expect(c).toContain('"createdBy"');
  });
});

// ------------------------------------------------------- C: source pins
const apiSrc = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
function fnBody(name) {
  const i = apiSrc.indexOf(`export async function ${name}(`);
  if (i < 0) return null;
  const j = apiSrc.indexOf('\nexport ', i + 10);
  return apiSrc.slice(i, j < 0 ? undefined : j);
}
const M5_FUNCTIONS = [
  'toggleLike', 'toggleReaction', 'toggleSave', 'votePoll', 'sharePost',
  'addComment', 'deleteComment', 'toggleGroupMembership',
  'respondGroupRequest', 'removeGroupMember', 'toggleEventRsvp',
  'markConversationRead', 'toggleMessageReaction', 'hideMessage',
  'voteChatPoll', 'setConversationFlag', 'setNickname',
  'acceptConversationRequest', 'setConversationMute', 'addGroupMembers',
  'removeGroupChatMember'
];
describe('C: M5 fresh-read source pins', () => {
  for (const name of M5_FUNCTIONS) {
    it(`${name} re-reads the stored row (sbGet) before writing`, () => {
      const body = fnBody(name);
      expect(body, `function not found: ${name}`).toBeTruthy();
      expect(body).toContain('sbGet(');
    });
  }
});

// ------------------------------------------------- B: behavioural (live)
let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const HUMAN = (name, username) => ({
  name, username, email: `${username}@example.com`, role: 'user', isBot: false,
  followers: [], following: [], closeFriends: [], settings: {}, createdAt: 1700000000000
});
const POST = {
  authorId: 'human2', text: 'hello world', image: '', visibility: 'public',
  audienceIds: ['human1', 'human2'], createdAt: 1700000000000, editedAt: 0,
  likes: [], reactions: {}, comments: [], shares: 0, sharedFrom: '', savedBy: [],
  groupId: '', pageId: '', pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false
};
const POLL_POST = {
  ...POST, text: 'pick one',
  poll: { options: [{ id: 'opt1', text: 'A' }, { id: 'opt2', text: 'B' }], votes: {} }
};
const EVENT = {
  createdBy: 'human2', title: 'Meetup', description: '', dateTime: 1800000000000,
  location: '', cover: '', visibility: 'public', audienceIds: [],
  going: [], interested: [], createdAt: 1700000000000
};
const GROUP = {
  name: 'Club', description: '', privacy: 'public', cover: '',
  createdBy: 'human2', members: ['human2'], createdAt: 1700000000000
};
const CONV = {
  participants: ['human1', 'human2'], isGroup: false, createdBy: 'human1', title: '',
  theme: null, emoji: null, nicknames: {}, typing: {}, archivedBy: [], mutedBy: [],
  pinnedBy: [], acceptedBy: ['human1', 'human2'], mutedUntil: {}, vanish: false,
  joinCode: '', createdAt: 1700000000000
};
const GCONV = { ...CONV, isGroup: true, createdBy: 'human2', title: 'GC' };
const GCONV2 = { ...CONV, isGroup: true, createdBy: 'human1', title: 'GC2' };
const MSG = {
  conversationId: 'conv1', participants: ['human1', 'human2'], senderId: 'human2',
  text: 'hi', image: '', audio: '', sticker: '', createdAt: 1700000001000,
  status: 'sent', readBy: [], reactions: {}, pinned: false, pinnedBy: '', pinnedAt: 0,
  unsent: false, hiddenFor: [], forwarded: false, vanish: false
};
const MSG_POLL = {
  ...MSG, text: '',
  poll: { question: 'q', multi: false, options: [{ id: 'o1', text: 'a', votes: [] }, { id: 'o2', text: 'b', votes: [] }] }
};
const OTHER_COMMENT = { id: 'c_other', authorId: 'human2', text: 'concurrent comment', createdAt: 1700000002000, replies: [] };
const C1 = { id: 'c1', authorId: 'human2', text: 'first comment', createdAt: 1700000001500, replies: [] };

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'hasan@example.com': 'human1', 'ayesha@example.com': 'human2', 'tanvir@example.com': 'human3' };
  fake.seed('users', 'human1', HUMAN('Hasan Human', 'hasan'));
  fake.seed('users', 'human2', HUMAN('Ayesha Khan', 'ayesha'));
  fake.seed('users', 'human3', HUMAN('Tanvir Ahmed', 'tanvir'));
  fake.seed('posts', 'post1', POST);
  fake.seed('posts', 'post2', POLL_POST);
  fake.seed('events', 'event1', EVENT);
  fake.seed('groups', 'group1', GROUP);
  fake.seed('conversations', 'conv1', CONV);
  fake.seed('conversations', 'gconv', GCONV);
  fake.seed('conversations', 'gconv2', GCONV2);
  fake.seed('messages', 'msg1', MSG);
  fake.seed('messages', 'msgpoll', MSG_POLL);
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('hasan@example.com', 'whatever');
  await settle();
});

describe('B: M5 fresh-read behaviour (concurrent writes survive)', () => {
  it('toggleLike keeps a concurrent like', async () => {
    fake.seed('posts', 'post1', { ...POST, likes: [] });
    await settle();
    fake.seed('posts', 'post1', { ...POST, likes: ['human2'] }); // concurrent, DB only
    await api.toggleLike('post1');
    expect(fake.get('posts', 'post1').likes).toEqual(expect.arrayContaining(['human2', 'human1']));
  });

  it('toggleSave keeps a concurrent save', async () => {
    fake.seed('posts', 'post1', { ...POST, savedBy: [] });
    await settle();
    fake.seed('posts', 'post1', { ...POST, savedBy: ['human2'] });
    await api.toggleSave('post1');
    expect(fake.get('posts', 'post1').savedBy).toEqual(expect.arrayContaining(['human2', 'human1']));
  });

  it('addComment keeps a concurrent comment', async () => {
    fake.seed('posts', 'post1', { ...POST, comments: [] });
    await settle();
    fake.seed('posts', 'post1', { ...POST, comments: [OTHER_COMMENT] });
    const mine = await api.addComment('post1', 'my comment');
    const comments = fake.get('posts', 'post1').comments;
    expect(comments).toHaveLength(2);
    expect(comments[0].id).toBe('c_other');
    expect(comments[1].id).toBe(mine.id);
  });

  it('deleteComment keeps a concurrent comment', async () => {
    fake.seed('posts', 'post1', { ...POST, comments: [C1] });
    await settle();
    fake.seed('posts', 'post1', { ...POST, comments: [C1, OTHER_COMMENT] });
    await api.deleteComment('post1', 'c1');
    const comments = fake.get('posts', 'post1').comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe('c_other');
  });

  it('votePoll keeps a concurrent vote', async () => {
    fake.seed('posts', 'post2', { ...POLL_POST, poll: { ...POLL_POST.poll, votes: {} } });
    await settle();
    fake.seed('posts', 'post2', { ...POLL_POST, poll: { ...POLL_POST.poll, votes: { human2: 'opt1' } } });
    await api.votePoll('post2', 'opt2');
    expect(fake.get('posts', 'post2').poll.votes).toEqual({ human2: 'opt1', human1: 'opt2' });
  });

  it('sharePost increments the STORED share count', async () => {
    fake.seed('posts', 'post1', { ...POST, shares: 0 });
    await settle();
    fake.seed('posts', 'post1', { ...POST, shares: 5 });
    await api.sharePost('post1');
    expect(fake.get('posts', 'post1').shares).toBe(6);
  });

  it('toggleEventRsvp keeps a concurrent RSVP', async () => {
    fake.seed('events', 'event1', { ...EVENT, going: [], interested: [] });
    await settle();
    fake.seed('events', 'event1', { ...EVENT, going: ['human2'], interested: [] });
    await api.toggleEventRsvp('event1', 'going');
    expect(fake.get('events', 'event1').going).toEqual(expect.arrayContaining(['human2', 'human1']));
  });

  it('toggleGroupMembership keeps a concurrent member', async () => {
    fake.seed('groups', 'group1', { ...GROUP, members: ['human2'] });
    await settle();
    fake.seed('groups', 'group1', { ...GROUP, members: ['human2', 'human3'] });
    await api.toggleGroupMembership('group1');
    expect(fake.get('groups', 'group1').members).toEqual(expect.arrayContaining(['human2', 'human3', 'human1']));
  });

  it('toggleMessageReaction keeps a concurrent reaction', async () => {
    fake.seed('messages', 'msg1', { ...MSG, reactions: {} });
    await settle();
    fake.seed('messages', 'msg1', { ...MSG, reactions: { '👍': ['human2'] } });
    await api.toggleMessageReaction('msg1', '❤️');
    const reactions = fake.get('messages', 'msg1').reactions;
    expect(reactions['👍']).toEqual(['human2']);
    expect(reactions['❤️']).toEqual(['human1']);
  });

  it('voteChatPoll keeps a concurrent vote', async () => {
    const base = { ...MSG_POLL, poll: { ...MSG_POLL.poll, options: [{ id: 'o1', text: 'a', votes: [] }, { id: 'o2', text: 'b', votes: [] }] } };
    fake.seed('messages', 'msgpoll', base);
    await settle();
    fake.seed('messages', 'msgpoll', { ...MSG_POLL, poll: { ...MSG_POLL.poll, options: [{ id: 'o1', text: 'a', votes: ['human2'] }, { id: 'o2', text: 'b', votes: [] }] } });
    await api.voteChatPoll('msgpoll', 'o2');
    const poll = fake.get('messages', 'msgpoll').poll;
    expect(poll.options.find((o) => o.id === 'o1').votes).toEqual(['human2']);
    expect(poll.options.find((o) => o.id === 'o2').votes).toEqual(['human1']);
  });

  it('markConversationRead keeps a concurrent readBy entry', async () => {
    fake.seed('messages', 'msg1', { ...MSG, readBy: [], status: 'sent' });
    await settle();
    fake.seed('messages', 'msg1', { ...MSG, readBy: ['human2'], status: 'sent' });
    await api.markConversationRead('conv1');
    const m = fake.get('messages', 'msg1');
    expect(m.readBy).toEqual(expect.arrayContaining(['human2', 'human1']));
    expect(m.status).toBe('read');
  });

  it('hideMessage keeps a concurrent hiddenFor entry', async () => {
    fake.seed('messages', 'msg1', { ...MSG, hiddenFor: [] });
    await settle();
    fake.seed('messages', 'msg1', { ...MSG, hiddenFor: ['human2'] });
    await api.hideMessage('msg1');
    expect(fake.get('messages', 'msg1').hiddenFor).toEqual(expect.arrayContaining(['human2', 'human1']));
  });

  it('setConversationFlag keeps a concurrent flag entry', async () => {
    fake.seed('conversations', 'conv1', { ...CONV, archivedBy: [] });
    await settle();
    fake.seed('conversations', 'conv1', { ...CONV, archivedBy: ['human2'] });
    await api.setConversationFlag('conv1', 'archivedBy', true);
    expect(fake.get('conversations', 'conv1').archivedBy).toEqual(expect.arrayContaining(['human2', 'human1']));
  });

  it('addGroupMembers preserves a concurrent removal', async () => {
    fake.seed('conversations', 'gconv', { ...GCONV, participants: ['human1', 'human2'] });
    await settle();
    fake.seed('conversations', 'gconv', { ...GCONV, participants: ['human1'] }); // human2 removed concurrently
    await api.addGroupMembers('gconv', ['human3']);
    const participants = fake.get('conversations', 'gconv').participants;
    expect(participants).toEqual(expect.arrayContaining(['human1', 'human3']));
    expect(participants).not.toContain('human2');
  });

  it('removeGroupChatMember keeps a concurrent addition', async () => {
    fake.seed('conversations', 'gconv2', { ...GCONV2, participants: ['human1', 'human2'] });
    await settle();
    fake.seed('conversations', 'gconv2', { ...GCONV2, participants: ['human1', 'human2', 'human3'] });
    await api.removeGroupChatMember('gconv2', 'human2');
    const participants = fake.get('conversations', 'gconv2').participants;
    expect(participants).toEqual(expect.arrayContaining(['human1', 'human3']));
    expect(participants).not.toContain('human2');
  });
});
