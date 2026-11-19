// Audit Fix Pack (2026-11-20) — LIVE-mode regressions, same fake-
// Firestore harness as live-bot-runner.test.js:
//  #1 the bot runner now DISCOVERS unanswered DMs before applying
//     its gates, so the panel summary/details state WHY a cycle took
//     no action (daily cap reached, bot deactivated) instead of a
//     bare "no actions"; and a reply lands in the conversation that
//     actually holds the human's message when duplicate threads
//     exist for the same pair.
//  #2 openConversation is idempotent in live mode (existing pair in
//     either stored order is found; a fresh pair is created once;
//     group chats never collide with the 1-1 lookup).
//  #10 live notification writes go through one choke point that
//     suppresses self-notifications (own like/comment), while other
//     users' actions still notify.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { counterDayKey, emptyBotCounters } from '../src/botLogic.js';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: true, isFirebaseConfigured: true, firebaseConfig: {},
  app: {}, auth: { fake: 'auth' }, db: { fake: 'db' }, storage: null, googleProvider: null
}));
vi.mock('firebase/firestore', async () => await import('./fake-firestore.js'));
vi.mock('firebase/auth', async () => (await import('./fake-firestore.js')).fakeAuth);
vi.mock('firebase/storage', () => ({
  ref: () => ({}), uploadBytes: async () => ({}), getDownloadURL: async () => ''
}));

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.document = { dispatchEvent: () => true };

let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

function stubFetchOk() {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'Gemini reply from the audit test' }] } }] })
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const ADMIN = { name: 'MeetBook Admin', username: 'admin', email: 'admin@meetbook.app', role: 'admin', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const HUMAN = { name: 'Hasan Human', username: 'hasan', email: 'hasan@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const botShape = (id, name, username, active) => ({
  id, name, username, avatar: '', bio: `AI Bot · ${name}.`,
  isBot: true, active,
  personality: { traits: ['curious'], tone: 'bright', interests: ['space'], systemPrompt: `You are ${name}.` },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 15 * 60 * 1000 },
  createdAt: Date.now() - 20 * 24 * 3600_000
});
const setCounters = (counters) => fake.seed('botSettings', 'counters', { day: counterDayKey(), counters, updatedAt: Date.now() });
const seedDm = (convId, botId, text, at) => {
  fake.seed('conversations', convId, { participants: ['human1', botId], createdAt: at - 10_000 });
  fake.seed('messages', `${convId}_m1`, {
    conversationId: convId, participants: ['human1', botId], senderId: 'human1',
    text, image: '', audio: '', createdAt: at, status: 'sent', readBy: ['human1']
  });
};

beforeAll(async () => {
  fake = (await import('./fake-firestore.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'admin@meetbook.app': 'admin1', 'hasan@example.com': 'human1' };
  fake.seed('users', 'admin1', ADMIN);
  fake.seed('users', 'human1', HUMAN);
  fake.seed('bots', 'bot_nova', botShape('bot_nova', 'Nova', 'nova.bot', true));
  fake.seed('bots', 'bot_pixel', botShape('bot_pixel', 'Pixel', 'pixel.bot', false));
  fake.seed('bots', 'bot_echo', botShape('bot_echo', 'Echo', 'echo.bot', true));
  fake.seed('botSettings', 'global', { enabled: true });
  fake.seed('botSecrets', 'config', { geminiApiKey: 'TEST_KEY' });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('admin@meetbook.app', 'admin123');
  await settle();
  api.stopBotRunner(); // manual cycles only — deterministic
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('#1 runner diagnostics — blocked DMs are reported, not hidden', () => {
  it('daily cap reached: no reply is sent, and the summary + details say why', async () => {
    seedDm('conv_cap', 'bot_nova', 'Nova, are you there?', Date.now() - 60_000);
    setCounters({ bot_nova: { ...emptyBotCounters(), messagesToday: 5, lastActionAt: Date.now() } });
    stubFetchOk();
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    // The cap is a designed limit — it still blocks the reply…
    expect(fake.all('messages').some((m) => m.conversationId === 'conv_cap' && m.senderId === 'bot_nova')).toBe(false);
    // …but the cycle no longer reports a bare "no actions": the
    // per-bot result, the summary and the stored details all name
    // the pending DM and the limit that blocked it.
    const entry = r.results.find((x) => x.bot === 'Nova' && x.pendingDMs === 1);
    expect(entry).toBeTruthy();
    expect(entry.reason).toMatch(/unanswered DM/);
    expect(entry.reason).toMatch(/daily message limit reached \(5\/5\)/);
    const runner = api.data().botRunner;
    expect(runner.lastSummary).toContain('unanswered DM');
    expect(runner.lastSummary).toContain('daily message limit reached');
    const detail = (runner.lastDetails || []).find((x) => x.bot === 'Nova');
    expect(detail.pendingDMs).toBe(1);
    expect(detail.note).toMatch(/daily message limit reached/);
    expect(detail.lastUnansweredAt).toBeGreaterThan(0);
  });

  it('deactivated bot: pending DMs are counted and named in the summary', async () => {
    seedDm('conv_off', 'bot_pixel', 'Pixel, ping!', Date.now() - 30_000);
    setCounters({});
    stubFetchOk();
    const r = await api.runBotCycle();
    const entry = r.results.find((x) => x.bot === 'Pixel');
    expect(entry.action).toBe('none');
    expect(entry.reason).toMatch(/deactivated — 1 unanswered DM\(s\) waiting/);
    expect(entry.pendingDMs).toBe(1);
    expect(api.data().botRunner.lastSummary).toContain('Pixel: bot is deactivated');
    expect(fake.all('messages').some((m) => m.conversationId === 'conv_off' && m.senderId === 'bot_pixel')).toBe(false);
  });

  it('duplicate threads for one pair: the reply lands in the thread holding the human message', async () => {
    // The audit scenario: an empty duplicate thread (bot-first
    // participant order, created later) next to the real history.
    fake.seed('conversations', 'conv_echo_empty', { participants: ['bot_echo', 'human1'], createdAt: Date.now() - 5_000 });
    seedDm('conv_echo_hist', 'bot_echo', 'Echo, tell me a space fact', Date.now() - 120_000);
    setCounters({});
    stubFetchOk();
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    const replies = fake.all('messages').filter((m) => m.senderId === 'bot_echo');
    expect(replies).toHaveLength(1);
    expect(replies[0].conversationId).toBe('conv_echo_hist');
  });
});

describe('#2 openConversation is idempotent in live mode', () => {
  it('finds the existing pair in either stored order, creates a fresh pair once, never returns a group', async () => {
    await api.login('hasan@example.com', 'hasan123');
    await settle();
    // A group thread containing both users must not satisfy the 1-1 lookup.
    fake.seed('conversations', 'conv_group_pair', { participants: ['human1', 'admin1', 'bot_echo'], isGroup: true, title: 'Trio', createdAt: Date.now() - 4000 });
    await settle();
    const totalBefore = fake.all('conversations').length;

    const first = await api.openConversation('admin1');
    expect(first.isGroup).toBeFalsy();
    expect([...first.participants].sort()).toEqual(['admin1', 'human1']);
    expect(fake.all('conversations').length).toBe(totalBefore + 1);

    const second = await api.openConversation('admin1');
    expect(second.id).toBe(first.id);
    expect(fake.all('conversations').length).toBe(totalBefore + 1);

    // The bot pair already has threads (seeded bot-first and
    // human-first across the tests above) — opening one returns an
    // existing thread and creates nothing new.
    const botThread = await api.openConversation('bot_nova');
    expect([...botThread.participants].sort()).toEqual(['bot_nova', 'human1']);
    expect(botThread.isGroup).toBeFalsy();
    expect(fake.all('conversations').length).toBe(totalBefore + 1);
    await api.login('admin@meetbook.app', 'admin123');
    await settle();
  });
});

describe('#10 live self-notifications are suppressed at the choke point', () => {
  it('own like/comment write no notification; another user\'s like does', async () => {
    await api.login('hasan@example.com', 'hasan123');
    await settle();
    await api.createPost({ text: 'Live self-notification probe', visibility: 'public' });
    await settle();
    const post = api.data().posts.find((p) => p.authorId === 'human1' && p.text.includes('self-notification probe'));
    expect(post).toBeTruthy();
    await api.toggleLike(post.id);
    await api.addComment(post.id, 'my own comment');
    await settle();
    const selfNotes = fake.all('notifications').filter((n) => n.userId === 'human1' && n.actorId === 'human1');
    expect(selfNotes).toEqual([]);
    await api.login('admin@meetbook.app', 'admin123');
    await settle();
    await api.toggleLike(post.id);
    await settle();
    const control = fake.all('notifications').filter((n) => n.userId === 'human1' && n.type === 'like' && n.actorId === 'admin1');
    expect(control).toHaveLength(1);
  });
});
