// Bot friend-request acceptance (live cycle): a request sent TO a bot
// is accepted by the bot cycle like an ordinary member would accept
// it — but paced (a few minutes old, at most 2 per bot per cycle) so
// accepts land human-late instead of robot-instant. The accept rides
// the staff sbUpdate path (the cycle runs as the Official admin), the
// sender gets the same friend_accept notification a human accept
// sends, and no daily cap (posts/comments/likes/messages) is consumed.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/supabase.js', async () => {
  const fake = await import('./fake-supabase.js');
  return {
    supabaseReady: true, isSupabaseConfigured: true,
    supabaseConfig: { url: 'https://fake.supabase.co', publishableKey: 'fake', projectRef: 'fake' },
    supabase: fake.fakeClient
  };
});

// store.js reads localStorage at import time; api.js dispatches DOM
// events when mirroring — shim both for the node runtime.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.document = { dispatchEvent: () => true };

import { counterDayKey } from '../src/botLogic.js';

let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const ADMIN = { name: 'MeetBook Admin', username: 'admin', email: 'admin@meetbook.app', role: 'admin', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const human = (id) => ({ name: `Human ${id}`, username: id, email: `${id}@example.com`, role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} });
const NOVA = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', avatar: '', bio: 'AI Bot · Curious about space.',
  isBot: true, active: true,
  personality: { traits: ['curious', 'witty'], tone: 'bright and playful', interests: ['space', 'science'], systemPrompt: 'You are Nova, a curious AI bot on MeetBook.' },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 15 * 60 * 1000 },
  createdAt: Date.now() - 20 * 24 * 3600_000
};

const acceptNotes = () => fake.all('notifications').filter((n) => n.type === 'friend_accept');

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'admin@meetbook.app': 'admin1' };
  fake.seed('users', 'admin1', ADMIN);
  for (const h of ['human1', 'human2', 'human3', 'human4', 'human5', 'human6']) fake.seed('users', h, human(h));
  fake.seed('bots', 'bot_nova', NOVA);
  fake.seed('botSettings', 'global', { enabled: true });
  fake.seed('botSecrets', 'config', {});
  fake.seed('botMemories', 'bot_nova', { botId: 'bot_nova', items: [] });
  // Counters pinned at "just acted" so the Decision Engine idles on
  // the min interval — the ONLY writes these cycles may make are the
  // friend accepts under test.
  fake.seed('botSettings', 'counters', {
    day: counterDayKey(),
    counters: { bot_nova: { postsToday: 0, commentsToday: 0, likesToday: 0, messagesToday: 0, lastActionAt: Date.now() } }
  });
  const now = Date.now();
  fake.seed('friendships', 'fr_oldest', { from: 'human1', to: 'bot_nova', status: 'pending', createdAt: now - 30 * 60_000 });
  fake.seed('friendships', 'fr_second', { from: 'human2', to: 'bot_nova', status: 'pending', createdAt: now - 20 * 60_000 });
  fake.seed('friendships', 'fr_third', { from: 'human3', to: 'bot_nova', status: 'pending', createdAt: now - 10 * 60_000 });
  fake.seed('friendships', 'fr_fresh', { from: 'human4', to: 'bot_nova', status: 'pending', createdAt: now - 60_000 });
  fake.seed('friendships', 'fr_accepted', { from: 'human5', to: 'bot_nova', status: 'accepted', createdAt: now - 60 * 60_000 });
  fake.seed('friendships', 'fr_declined', { from: 'human6', to: 'bot_nova', status: 'declined', createdAt: now - 50 * 60_000 });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('admin@meetbook.app', 'admin123');
  await settle();
  api.stopBotRunner(); // manual cycles only — keep the suite deterministic
});

describe('bot friend-request acceptance (live cycle)', () => {
  it('accepts the two oldest pending requests, notifies the senders, touches nothing else', async () => {
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    const accepts = r.results.filter((x) => x.bot === 'Nova' && x.action === 'friend-accept');
    expect(accepts).toHaveLength(2);

    // The cap: the two OLDEST pending requests flipped; the third
    // (also old enough) waits for the next cycle.
    expect(fake.get('friendships', 'fr_oldest').status).toBe('accepted');
    expect(fake.get('friendships', 'fr_second').status).toBe('accepted');
    expect(fake.get('friendships', 'fr_third').status).toBe('pending');
    // Too fresh: sent a minute ago — a human would not have seen it yet.
    expect(fake.get('friendships', 'fr_fresh').status).toBe('pending');
    // Non-pending rows are never touched.
    expect(fake.get('friendships', 'fr_accepted').status).toBe('accepted');
    expect(fake.get('friendships', 'fr_declined').status).toBe('declined');

    // Each sender hears about it, from the bot, in the human wording.
    const notes = acceptNotes();
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.userId).sort()).toEqual(['human1', 'human2']);
    for (const n of notes) {
      expect(n.actorId).toBe('bot_nova');
      expect(n.text).toBe('Nova accepted your friend request.');
    }

    // No daily cap is consumed by an accept.
    const c = fake.get('botSettings', 'counters').counters.bot_nova;
    expect(c.postsToday).toBe(0);
    expect(c.commentsToday).toBe(0);
    expect(c.likesToday).toBe(0);
    expect(c.messagesToday).toBe(0);

    // The accept is logged in the per-bot decision history like any
    // other cycle action.
    const doc = fake.get('botRunners', 'decisions_bot_nova');
    expect((doc?.items || []).some((x) => x.action === 'friend-accept')).toBe(true);
  });

  it('the next cycle drains the next-oldest; the fresh request accepts only once it has aged', async () => {
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    expect(r.results.filter((x) => x.bot === 'Nova' && x.action === 'friend-accept')).toHaveLength(1);
    expect(fake.get('friendships', 'fr_third').status).toBe('accepted');
    expect(acceptNotes().map((n) => n.userId).sort()).toEqual(['human1', 'human2', 'human3']);
    // Still only ~a minute old in wall-clock terms: still waiting.
    expect(fake.get('friendships', 'fr_fresh').status).toBe('pending');

    // Age it past the threshold — the following cycle accepts it.
    fake.seed('friendships', 'fr_fresh', { from: 'human4', to: 'bot_nova', status: 'pending', createdAt: Date.now() - 6 * 60_000 });
    const r2 = await api.runBotCycle();
    expect(r2.ran).toBe(true);
    expect(fake.get('friendships', 'fr_fresh').status).toBe('accepted');
    expect(acceptNotes().map((n) => n.userId).sort()).toEqual(['human1', 'human2', 'human3', 'human4']);
  });
});
