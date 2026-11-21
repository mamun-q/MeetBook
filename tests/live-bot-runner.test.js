// Live-mode bot runner (Spark plan): firebase.js is mocked as READY and
// the firebase SDK modules are replaced by an in-memory fake, so the
// REAL api.js runs against Firestore-shaped data — admin signs in, the
// runner auto-starts, a manual cycle writes a bot post + a bot chat
// reply through the Firestore paths, counters persist, the kill switch
// and admin gating hold, and a Gemini outage still yields template
// posts. (Security rules themselves are not executed here.)
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: true, isFirebaseConfigured: true, firebaseConfig: {},
  app: {}, auth: { fake: 'auth' }, db: { fake: 'db' }, storage: null, googleProvider: null
}));
vi.mock('firebase/firestore', async () => await import('./fake-firestore.js'));
vi.mock('firebase/auth', async () => (await import('./fake-firestore.js')).fakeAuth);
vi.mock('firebase/storage', () => ({
  ref: () => ({}), uploadBytes: async () => ({}), getDownloadURL: async () => ''
}));

// store.js reads localStorage at import time; api.js dispatches DOM
// events when mirroring Firestore — shim both for the node runtime.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.document = { dispatchEvent: () => true };

let api;
let fake;
const GEMINI_TEXT = 'Gemini text from the live runner test';
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

function stubFetchOk() {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI_TEXT }] } }] })
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const ADMIN = { name: 'MeetBook Admin', username: 'admin', email: 'admin@meetbook.app', role: 'admin', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const HUMAN = { name: 'Hasan Human', username: 'hasan', email: 'hasan@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const NOVA = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', avatar: '', bio: 'AI Bot · Curious about space.',
  isBot: true, active: true,
  personality: { traits: ['curious', 'witty'], tone: 'bright and playful', interests: ['space', 'science'], systemPrompt: 'You are Nova, a curious AI bot on MeetBook.' },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 15 * 60 * 1000 },
  createdAt: Date.now() - 20 * 24 * 3600_000
};

beforeAll(async () => {
  fake = (await import('./fake-firestore.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'admin@meetbook.app': 'admin1', 'hasan@example.com': 'human1' };
  fake.seed('users', 'admin1', ADMIN);
  fake.seed('users', 'human1', HUMAN);
  // NOTE: no users/bot_nova doc — the runner must create it.
  fake.seed('bots', 'bot_nova', NOVA);
  fake.seed('botSettings', 'global', { enabled: true });
  fake.seed('botSecrets', 'config', { geminiApiKey: 'TEST_KEY' });
  fake.seed('botMemories', 'bot_nova', { botId: 'bot_nova', items: [{ id: 'mem1', text: 'Nova loves space facts.', createdAt: 1, updatedAt: 1, pinned: false }] });
  fake.seed('posts', 'post1', {
    authorId: 'human1', text: 'Hello world from Hasan', image: '', visibility: 'public', audienceIds: [],
    createdAt: Date.now() - 60_000, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0,
    sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: ''
  });
  fake.seed('posts', 'post_reply1', {
    authorId: 'bot_nova', text: 'AI Bot post · Space facts for everyone', image: '', visibility: 'public', audienceIds: [],
    createdAt: Date.now() - 30_000, editedAt: 0, likes: [], reactions: {},
    comments: [{ id: 'cm1', authorId: 'human1', text: 'Great post, Nova!', createdAt: Date.now() - 20_000, replies: [] }],
    shares: 0, sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false, generatedBy: 'gemini'
  });
  fake.seed('conversations', 'conv1', { participants: ['human1', 'bot_nova'], createdAt: Date.now() - 50_000 });
  fake.seed('messages', 'msg1', {
    conversationId: 'conv1', participants: ['human1', 'bot_nova'], senderId: 'human1',
    text: 'Hi Nova, tell me about space', image: '', audio: '', createdAt: Date.now() - 40_000, status: 'sent', readBy: ['human1']
  });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('admin@meetbook.app', 'admin123');
  await settle();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('live bot runner (Spark)', () => {
  it('auto-starts for an admin session and reports active status', () => {
    expect(api.me()?.role).toBe('admin');
    expect(api.botRunnerIsActive()).toBe(true);
    expect(api.data().botRunner.active).toBe(true);
    api.stopBotRunner(); // keep the rest of the suite deterministic
    expect(api.botRunnerIsActive()).toBe(false);
  });

  it('runs a cycle: Gemini post + chat reply, counters, bot user doc, brain', async () => {
    const fetchFn = stubFetchOk();
    // Decision Engine v2 picks among open actions by personality
    // weight — pin the rng so this cycle deterministically picks the
    // post action (roll 0.05 lands in the post band).
    const rngSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    let r;
    try {
      r = await api.runBotCycle();
    } finally {
      rngSpy.mockRestore();
    }
    expect(r.ran).toBe(true);
    const actions = r.results.filter((x) => x.bot === 'Nova').map((x) => x.action);
    expect(actions).toContain('message');
    expect(actions).toContain('post');
    expect(fetchFn.mock.calls[0][0]).toContain('key=TEST_KEY');

    const botPosts = fake.all('posts').filter((p) => p.authorId === 'bot_nova');
    const botPost = botPosts[botPosts.length - 1]; // newest = this cycle's post (an older seeded bot post exists)
    expect(botPost).toBeTruthy();
    expect(botPost.text).toContain(GEMINI_TEXT);
    expect(botPost.generatedBy).toBe('gemini');
    expect(botPost.visibility).toBe('public');
    expect(botPost.audienceIds).toEqual([]);

    const reply = fake.all('messages').find((m) => m.conversationId === 'conv1' && m.senderId === 'bot_nova');
    expect(reply).toBeTruthy();
    expect(reply.text).toBe(GEMINI_TEXT);
    expect(reply.participants).toEqual(['human1', 'bot_nova']);

    const counters = fake.get('botSettings', 'counters');
    expect(counters.counters.bot_nova.postsToday).toBe(1);
    expect(counters.counters.bot_nova.messagesToday).toBe(1);
    expect(counters.counters.bot_nova.lastActionAt).toBeGreaterThan(0);

    const botUser = fake.get('users', 'bot_nova');
    expect(botUser.isBot).toBe(true);
    expect(botUser.role).toBe('bot');

    await settle();
    expect(fake.get('botBrains', 'bot_nova').provider).toBe('gemini');
    expect(api.data().botRunner.lastSummary).toContain('Nova');
  });

  it('never replies twice and honours the min interval on an immediate second cycle', async () => {
    stubFetchOk();
    const postsBefore = fake.all('posts').length;
    const msgsBefore = fake.all('messages').length;
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    expect(fake.all('posts').length).toBe(postsBefore);
    expect(fake.all('messages').length).toBe(msgsBefore);
  });

  it('kill switch off -> the cycle does nothing', async () => {
    fake.seed('botSettings', 'global', { enabled: false });
    await settle();
    const postsBefore = fake.all('posts').length;
    const r = await api.runBotCycle();
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/kill switch/i);
    expect(fake.all('posts').length).toBe(postsBefore);
    fake.seed('botSettings', 'global', { enabled: true });
    await settle();
  });

  it('Gemini failure -> template text is still posted', async () => {
    fake.remove('botSettings', 'counters'); // fresh counters: interval + limits reset
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    // Pin the Decision Engine v2 rng so the cycle picks the post action.
    const rngSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    let r;
    try {
      r = await api.runBotCycle();
    } finally {
      rngSpy.mockRestore();
    }
    expect(r.ran).toBe(true);
    const botPosts = fake.all('posts').filter((p) => p.authorId === 'bot_nova');
    const newest = botPosts[botPosts.length - 1];
    expect(newest.generatedBy).toBe('template-fallback');
    expect(newest.text).toContain('AI Bot post ·');
    expect(newest.text).not.toContain(GEMINI_TEXT);
    await settle();
    expect(fake.get('botBrains', 'bot_nova').provider).toBe('template-fallback');
  });

  it('Phase 3: cycle decisions are persisted to the per-bot history doc', async () => {
    const doc = fake.get('botRunners', 'decisions_bot_nova');
    expect(doc).toBeTruthy();
    const actions = (doc.items || []).map((x) => x.action);
    expect(actions).toContain('post');
    expect(actions).toContain('message');
    expect((doc.items || []).every((x) => typeof x.at === 'number' && x.at > 0)).toBe(true);
  });

  it('Phase 2: the bot replies to a human comment on its own post', async () => {
    fake.remove('botSettings', 'counters'); // fresh counters
    stubFetchOk();
    // rng 0.5 lands in Nova's comment band (weights post 3 / comment 4 / like 2).
    const rngSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let r;
    try {
      r = await api.runBotCycle();
    } finally {
      rngSpy.mockRestore();
    }
    expect(r.ran).toBe(true);
    const post = fake.get('posts', 'post_reply1');
    const replies = post.comments.find((c) => c.id === 'cm1')?.replies || [];
    expect(replies).toHaveLength(1);
    expect(replies[0].authorId).toBe('bot_nova');
    expect(r.results.find((x) => x.bot === 'Nova' && x.action === 'comment-reply')).toBeTruthy();
  });

  it('a non-admin session never starts the runner and cannot run a cycle', async () => {
    fake.setAuthUser({ uid: 'human1' });
    fake.seed('users', 'human1', { ...HUMAN, online: true }); // re-fire the users snapshot
    await settle();
    expect(api.me()?.id).toBe('human1');
    expect(api.botRunnerIsActive()).toBe(false);
    expect(api.startBotRunner()).toBe(false);
    const r = await api.runBotCycle();
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/admin/i);
    fake.setAuthUser({ uid: 'admin1' });
    await settle();
    api.stopBotRunner();
  });
});
