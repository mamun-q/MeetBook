// Realtime recovery — LIVE mode against the fake Supabase. Pins the
// fix for Limon's phone report "সাইট রিলোড না দিলে নতুন মেসেজ
// দেখাচ্ছে না" (new messages don't appear until a reload): a
// backgrounded tab or a network blip kills the realtime websocket
// and the mirror silently goes stale. The defences pinned here:
//  (a) a table channel that had joined and then reports
//      CHANNEL_ERROR / CLOSED is rebuilt (a NEW channel object
//      replaces it after the backoff) and its table is refetched
//      immediately, so missed changes land;
//  (b) returning to the tab (visibilitychange -> visible), window
//      focus, and the browser coming back online each trigger a
//      coalesced resync refetch of the watched tables;
//  (c) the lifecycle handlers are registered exactly once, however
//      many sign-in/out cycles run.
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

// Document/window stubs WITH listener capture, installed before
// api.js is imported: the recovery hooks register against these.
const docListeners = new Map();
const winListeners = new Map();
const capture = (map) => (type, fn) => {
  if (!map.has(type)) map.set(type, []);
  map.get(type).push(fn);
};
const fire = (map, type) => { for (const fn of [...(map.get(type) || [])]) fn(); };
const docStub = {
  visibilityState: 'visible',
  dispatchEvent: () => true,
  addEventListener: capture(docListeners),
  removeEventListener: () => {}
};
globalThis.document = docStub;
globalThis.window = {
  location: { origin: 'https://fake.supabase.co', pathname: '/' },
  addEventListener: capture(winListeners),
  removeEventListener: () => {}
};

let api;
let fake;
let fakeClient;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await sleep(15); await sleep(15); };

// ---- request instrumentation (same pattern as the Speed Pack) --
const records = [];
function instrument() {
  const origFrom = fakeClient.from;
  fakeClient.from = (table) => {
    const b = origFrom(table);
    const ex = b.execute.bind(b);
    b.execute = async () => {
      records.push({ table, op: b.op });
      return ex();
    };
    return b;
  };
}
const selects = (table) => records.filter((r) => r.table === table && r.op === 'select').length;

const userRow = (name, username, email, role) => ({
  name, username, email, role, isBot: false, bio: '', avatar: '', cover: '',
  followers: [], following: [], closeFriends: [], settings: {}, createdAt: Date.now() - 60_000
});
const messageRow = (id, senderId, text, createdAt) => ({
  conversationId: 'conv1', participants: ['human1', 'human2'], senderId, text,
  image: '', audio: '', createdAt, status: 'sent', readBy: [senderId],
  reactions: null, pinned: false, pinnedBy: '', pinnedAt: 0, editedAt: null,
  unsent: false, hiddenFor: []
});

beforeAll(async () => {
  const fakeMod = await import('./fake-supabase.js');
  fake = fakeMod.fakeControl;
  fakeClient = fakeMod.fakeClient;
  fake.reset();
  fake.usersByEmail = { 'me@example.com': 'human1', 'friend@example.com': 'human2' };
  fake.seed('users', 'human1', userRow('Mamun Hossen', 'your.name', 'me@example.com', 'user'));
  fake.seed('users', 'human2', userRow('Ayesha Khan', 'ayesha', 'friend@example.com', 'user'));
  fake.seed('conversations', 'conv1', {
    participants: ['human1', 'human2'], lastMessage: 'hello', lastMessageAt: Date.now() - 1_000,
    createdAt: Date.now() - 60_000, typing: {}
  });
  fake.seed('messages', 'm1', messageRow('m1', 'human2', 'hello', Date.now() - 1_000));
  fake.seed('notifications', 'n1', {
    userId: 'human1', actorId: 'human2', actorName: 'Ayesha Khan', type: 'message',
    text: 'sent you a message', createdAt: Date.now() - 1_000, read: false
  });
  instrument();
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('me@example.com', 'password123');
  await settle();
});

let firstMessagesChannel = null;

describe('realtime recovery — channel rebuild', () => {
  it('boot subscribes exactly one channel per watched table', () => {
    expect(fake.channelsNamed('mb-sync-messages')).toHaveLength(1);
    expect(fake.channelsNamed('mb-sync-posts')).toHaveLength(1);
    expect(api.data().messages.map((m) => m.id)).toContain('m1');
  });

  it('(a) CHANNEL_ERROR on a joined messages channel refetches at once and rebuilds the channel', async () => {
    const original = fake.channelsNamed('mb-sync-messages')[0];
    firstMessagesChannel = original;
    const selectsBefore = selects('messages');
    fake.emitChannelStatus('mb-sync-messages', 'CHANNEL_ERROR');
    // The catch-up refetch is immediate — it does not wait for the
    // rebuild's backoff.
    await settle();
    expect(selects('messages')).toBeGreaterThan(selectsBefore);
    // The rebuild lands after the first backoff step (1s) as a NEW
    // channel object; the dead one is gone.
    await sleep(1300);
    const rebuilt = fake.channelsNamed('mb-sync-messages');
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).not.toBe(original);
    // And the rebuilt channel actually delivers: a fresh message
    // from the other participant reaches the mirror.
    fake.seed('messages', 'm2', messageRow('m2', 'human2', 'are you there?', Date.now()));
    await settle();
    expect(api.data().messages.map((m) => m.id)).toContain('m2');
  });

  it('(a) CLOSED on a joined posts channel also rebuilds it', async () => {
    const original = fake.channelsNamed('mb-sync-posts')[0];
    const selectsBefore = selects('posts');
    fake.emitChannelStatus('mb-sync-posts', 'CLOSED');
    await settle();
    expect(selects('posts')).toBeGreaterThan(selectsBefore);
    await sleep(1300);
    const rebuilt = fake.channelsNamed('mb-sync-posts');
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).not.toBe(original);
  });

  it('(a) a failure status from an already-replaced channel is ignored', async () => {
    // The first messages channel was replaced by the rebuild above.
    // A late status delivered to that DETACHED channel's retained
    // callback — exactly what our own removeChannel provokes with
    // CLOSED in production — must not refetch or rebuild again.
    const current = fake.channelsNamed('mb-sync-messages')[0];
    expect(current).not.toBe(firstMessagesChannel);
    const selectsBefore = selects('messages');
    firstMessagesChannel.statusCallback('CHANNEL_ERROR');
    firstMessagesChannel.statusCallback('CLOSED');
    await settle();
    expect(selects('messages')).toBe(selectsBefore);
    await sleep(1200); // a full first-backoff window: no rebuild
    expect(fake.channelsNamed('mb-sync-messages')[0]).toBe(current);
    expect(selects('messages')).toBe(selectsBefore);
  });
});

describe('realtime recovery — lifecycle resync', () => {
  it('(b) visibilitychange to visible refetches messages, conversations and notifications', async () => {
    await settle();
    const m = selects('messages');
    const c = selects('conversations');
    const n = selects('notifications');
    docStub.visibilityState = 'visible';
    fire(docListeners, 'visibilitychange');
    await settle();
    expect(selects('messages')).toBeGreaterThan(m);
    expect(selects('conversations')).toBeGreaterThan(c);
    expect(selects('notifications')).toBeGreaterThan(n);
  });

  it('(b) window focus triggers a resync too', async () => {
    await settle();
    const m = selects('messages');
    fire(winListeners, 'focus');
    await settle();
    expect(selects('messages')).toBeGreaterThan(m);
  });

  it('(b) coming back online triggers a resync too', async () => {
    await settle();
    const m = selects('messages');
    fire(winListeners, 'online');
    await settle();
    expect(selects('messages')).toBeGreaterThan(m);
  });

  it('(b) a resync while signed out is a no-op', async () => {
    fake.setAuthUser(null);
    await settle();
    const m = selects('messages');
    fire(docListeners, 'visibilitychange');
    fire(winListeners, 'focus');
    await settle();
    expect(selects('messages')).toBe(m);
    // Restore the session for the registration test below.
    fake.setAuthUser({ id: 'human1', email: 'me@example.com' });
    await settle();
  });
});

describe('realtime recovery — one-time registration', () => {
  it('(c) lifecycle handlers are registered exactly once across repeated sync starts', async () => {
    // Token-refresh style re-entry (same user): startRemoteSync
    // early-returns, but passes the registration guard again.
    fake.setAuthUser({ id: 'human1', email: 'me@example.com' });
    await settle();
    // A full sign-out / sign-in cycle: stopRemoteSync must not
    // unregister, and the fresh startRemoteSync must not duplicate.
    fake.setAuthUser(null);
    await settle();
    fake.setAuthUser({ id: 'human1', email: 'me@example.com' });
    await settle();
    expect(docListeners.get('visibilitychange')).toHaveLength(1);
    expect(winListeners.get('focus')).toHaveLength(1);
    expect(winListeners.get('online')).toHaveLength(1);
    // And the once-registered handlers still work after the churn.
    const m = selects('messages');
    fire(winListeners, 'focus');
    await settle();
    expect(selects('messages')).toBeGreaterThan(m);
  });
});
