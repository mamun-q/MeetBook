// Speed Pack (boot performance) — LIVE mode against the fake
// Supabase. Pins:
//  - FAST GATE: the signed-in user's own profile row is fetched alone
//    (single-row get) and seeded into the mirror, so me() resolves
//    while the 300-row users list is still in flight — the splash no
//    longer waits for the whole herd.
//  - TIERED BOOT: feed-critical slices (users/posts/stories/chat…)
//    are requested before the second tier (events/groups/pages/
//    reviews/bots/announcements…), and tier-2 data still lands.
//  - STAFF GATING: a non-staff boot never queries the staff-only
//    slices (adminLogs / botActivities / botLogs / the unfiltered
//    Reports Center slice); a staff boot does.
//  - REFETCH COALESCING: a burst of realtime events on one table
//    while a refetch is in flight collapses into ONE trailing
//    refetch (2 rounds for 3 events, not 3 rounds).
import { describe, it, expect, vi, beforeAll } from 'vitest';

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

let api;
let fake;
let fakeClient;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await sleep(15); await sleep(15); };

// ---- request instrumentation -------------------------------------------
// Every PostgREST execute() is recorded ({table, op, single, limit,
// filters}) and can be artificially delayed per a mutable rule, so the
// tests can hold one query "in flight" while the rest of the boot (or
// a realtime burst) proceeds around it.
const records = [];
let delayRule = null; // (table, builder) => ms
function instrument() {
  const origFrom = fakeClient.from;
  fakeClient.from = (table) => {
    const b = origFrom(table);
    const ex = b.execute.bind(b);
    b.execute = async () => {
      records.push({
        table, op: b.op, single: b.singleMode, limit: b.limitN,
        filters: b.filters.map((f) => `${f.type}:${f.col}`)
      });
      const ms = delayRule ? delayRule(table, b) : 0;
      if (ms) await sleep(ms);
      return ex();
    };
    return b;
  };
}
const selects = (list, table) => list.filter((r) => r.table === table && r.op === 'select');
const firstIdx = (list, pred) => list.findIndex(pred);

const userRow = (name, username, email, role) => ({
  name, username, email, role, isBot: false, bio: '', avatar: '', cover: '',
  followers: [], following: [], closeFriends: [], settings: {}, createdAt: Date.now() - 60_000
});
const postRow = (id, authorId, text) => ({
  authorId, text, image: '', visibility: 'public', audienceIds: [],
  createdAt: Date.now() - 60_000, editedAt: 0, likes: [], reactions: {},
  comments: [], shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '',
  pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false
});

let bootRecords = [];

beforeAll(async () => {
  const fakeMod = await import('./fake-supabase.js');
  fake = fakeMod.fakeControl;
  fakeClient = fakeMod.fakeClient;
  fake.reset();
  fake.usersByEmail = { 'me@example.com': 'human1', 'friend@example.com': 'human2', 'admin@example.com': 'admin1' };
  fake.seed('users', 'human1', userRow('Mamun Hossen', 'your.name', 'me@example.com', 'user'));
  fake.seed('users', 'human2', userRow('Ayesha Khan', 'ayesha', 'friend@example.com', 'user'));
  fake.seed('users', 'admin1', userRow('Boss Admin', 'boss', 'admin@example.com', 'admin'));
  fake.seed('posts', 'post1', postRow('post1', 'human2', 'Ayesha post'));
  fake.seed('events', 'ev1', {
    title: 'Launch Party', description: '', dateTime: Date.now() + 86_400_000, location: '', cover: '',
    createdBy: 'human2', visibility: 'public', audienceIds: [], going: [], interested: [], createdAt: Date.now() - 1_000
  });
  fake.seed('groups', 'g1', {
    name: 'Public Group', description: '', privacy: 'public', cover: '',
    createdBy: 'human2', members: ['human2'], createdAt: Date.now() - 1_000
  });
  fake.seed('pages', 'pg1', { name: 'Ayesha Page', category: 'Community', about: '', avatar: '', cover: '', ownerId: 'human2', followers: [], createdAt: Date.now() - 60_000 });
  fake.seed('bots', 'bot1', {
    id: 'bot1', name: 'Nova', username: 'nova.bot', avatar: '', bio: 'AI Bot · Nova.', isBot: true, active: true,
    personality: { traits: ['curious'], tone: 'bright', interests: ['space'], systemPrompt: 'You are Nova.' },
    limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 900_000 },
    createdAt: Date.now() - 60_000
  });
  fake.seed('adminLogs', 'log1', { actorId: 'admin1', action: 'test', createdAt: Date.now() - 1_000 });
  fake.seed('botLogs', 'bl1', { text: 'boot log', createdAt: Date.now() - 1_000 });
  fake.seed('botActivities', 'ba1', { botId: 'bot1', text: 'did a thing', createdAt: Date.now() - 1_000 });
  instrument();
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
});

describe('speed pack — fast gate', () => {
  it('me() resolves from the seeded own row while the users list is still in flight', async () => {
    // Hold ONLY the 300-row users list query for 60ms; single-row
    // gets (ensureAuthProfile + the gate fetch) stay instant.
    delayRule = (table, b) => (table === 'users' && b.op === 'select' && b.limitN === 300 ? 60 : 0);
    await api.login('me@example.com', 'password123');
    await sleep(20);
    // The gate data is already here: my row, alone in the mirror.
    expect(api.me()?.id).toBe('human1');
    expect(api.data().users.map((u) => u.id)).toEqual(['human1']);
    // Once the list lands, the seed is replaced by the whole list.
    await sleep(150);
    delayRule = null;
    expect(api.data().users.map((u) => u.id).sort()).toEqual(['admin1', 'human1', 'human2']);
    bootRecords = records.slice();
  });
});

describe('speed pack — tiered boot', () => {
  it('tier-1 slices are requested before tier-2 slices', () => {
    const usersList = firstIdx(bootRecords, (r) => r.table === 'users' && r.op === 'select' && r.limit === 300);
    const usersGet = firstIdx(bootRecords, (r) => r.table === 'users' && r.op === 'select' && r.single === 'maybe');
    expect(usersGet).toBeGreaterThanOrEqual(0);
    expect(usersGet).toBeLessThan(usersList); // a single-row get precedes the herd
    expect(firstIdx(bootRecords, (r) => r.table === 'posts' && r.op === 'select'))
      .toBeLessThan(firstIdx(bootRecords, (r) => r.table === 'events' && r.op === 'select'));
    expect(firstIdx(bootRecords, (r) => r.table === 'messages' && r.op === 'select'))
      .toBeLessThan(firstIdx(bootRecords, (r) => r.table === 'pages' && r.op === 'select'));
    expect(usersList).toBeLessThan(firstIdx(bootRecords, (r) => r.table === 'bots' && r.op === 'select'));
    expect(firstIdx(bootRecords, (r) => r.table === 'stories' && r.op === 'select'))
      .toBeLessThan(firstIdx(bootRecords, (r) => r.table === 'groups' && r.op === 'select'));
  });

  it('tier-2 data still lands (views are delayed, never starved)', () => {
    expect(api.data().events.map((e) => e.id)).toContain('ev1');
    // NOTE: fetched groups are asserted by name, not id — mapGroup
    // (via normaliseGroup) drops the row id, a pre-existing defect
    // outside the Speed Pack's scope (see the pack report).
    expect(api.data().groups.map((g) => g.name)).toContain('Public Group');
    expect(api.data().pages.map((p) => p.id)).toContain('pg1');
    expect(api.data().bots.map((b) => b.id)).toContain('bot1');
  });

  it('a non-staff boot never queries the staff-only slices', () => {
    expect(selects(bootRecords, 'adminLogs')).toEqual([]);
    expect(selects(bootRecords, 'botActivities')).toEqual([]);
    expect(selects(bootRecords, 'botLogs')).toEqual([]);
    // Reports ARE queried for everyone — but only the caller's own
    // slices (filed / about-me), never the unfiltered staff slice.
    for (const r of selects(bootRecords, 'reports')) expect(r.filters.length).toBeGreaterThan(0);
  });
});

describe('speed pack — refetch coalescing', () => {
  it('a burst of realtime events during an in-flight refetch collapses into one trailing refetch', async () => {
    await settle();
    // Hold every posts select for 30ms so the first refetch is still
    // in flight when the follow-up events arrive.
    delayRule = (table, b) => (table === 'posts' && b.op === 'select' ? 30 : 0);
    const before = records.length;
    fake.seed('posts', 'burst1', postRow('burst1', 'human2', 'burst one'));
    await null; // let the fake's realtime flush fire
    fake.seed('posts', 'burst2', postRow('burst2', 'human2', 'burst two'));
    await null;
    fake.seed('posts', 'burst3', postRow('burst3', 'human2', 'burst three'));
    await null;
    await sleep(180);
    delayRule = null;
    // 3 events, but only 2 refetch rounds (leading + one trailing),
    // each round running the 3 post slices = 6 selects, not 9.
    expect(selects(records.slice(before), 'posts').length).toBe(6);
    const ids = api.data().posts.map((p) => p.id);
    expect(ids).toContain('burst1');
    expect(ids).toContain('burst2');
    expect(ids).toContain('burst3');
  });
});

describe('speed pack — staff boot', () => {
  it('a staff boot does fetch the staff-only slices', async () => {
    records.length = 0;
    fake.setAuthUser({ id: 'admin1', email: 'admin@example.com' });
    await settle();
    await settle();
    expect(selects(records, 'adminLogs').length).toBeGreaterThan(0);
    expect(selects(records, 'botLogs').length).toBeGreaterThan(0);
    expect(selects(records, 'botActivities').length).toBeGreaterThan(0);
    // The unfiltered Reports Center slice is among them.
    expect(selects(records, 'reports').some((r) => r.filters.length === 0)).toBe(true);
    expect(api.data().adminLogs.map((l) => l.id)).toContain('log1');
  });
});
