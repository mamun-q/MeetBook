// Integration test for the Spark-plan Gemini wiring: firebase.js is
// mocked into demo mode, so the REAL api.js generation path runs —
// admin saves a key -> runner cycle -> Gemini text lands in a bot post
// and the botBrain records the provider; a provider failure falls back
// to template text and records that instead.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: false, isFirebaseConfigured: false, firebaseConfig: {},
  app: null, auth: null, db: null, storage: null, googleProvider: null
}));

// store.js reads localStorage at import time — shim it before importing.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

let api;
let store;
const GEMINI_TEXT = 'Gemini-generated text from the wiring test';

function stubFetchOk() {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI_TEXT }] } }] })
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeAll(async () => {
  store = await import('../src/store.js');
  api = await import('../src/api.js');
  await api.login('admin@meetbook.app', 'admin123');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('Gemini free wiring (demo-mode generation path)', () => {
  it('rejects key management for non-admins and empty keys', async () => {
    await expect(api.saveGeminiApiKey('   ')).rejects.toThrow(/Paste a Gemini API key/);
  });

  it('uses Gemini text for bot posts and records the brain provider', async () => {
    await api.saveGeminiApiKey('TEST_KEY_123');
    expect(api.data().botSecrets.geminiApiKey).toBe('TEST_KEY_123');
    const fetchFn = stubFetchOk();
    const r = await api.runDemoBotCycle();
    expect(r.ran).toBe(true);
    expect(fetchFn).toHaveBeenCalled();
    const botPost = store.getState().posts.find((p) => p.authorId === 'bot_nova');
    expect(botPost.text).toContain(GEMINI_TEXT);
    expect(botPost.generatedBy).toBe('gemini');
    const brain = store.getState().botBrains.bot_nova;
    expect(brain.provider).toBe('gemini');
    expect(brain.model).toBe('gemini-3.5-flash');
  });

  it('uses Gemini for 1-1 bot message replies too', async () => {
    stubFetchOk();
    const reply = await api.demoBotReply('bot_sage', 'Tell me about books');
    expect(reply).toBe(GEMINI_TEXT);
  });

  it('falls back to template text (and logs a warning) when Gemini fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const before = store.getState().posts.length;
    const r = await api.runDemoBotCycle();
    expect(r.ran).toBe(true);
    const posts = store.getState().posts;
    expect(posts.length).toBeGreaterThan(before);
    // Posts are unshifted, so the first bot_nova post is the newest one.
    const newBotPost = posts.find((p) => p.authorId === 'bot_nova');
    expect(newBotPost.text).not.toContain(GEMINI_TEXT);
    expect(newBotPost.generatedBy).toBe('template-fallback');
    expect(store.getState().botBrains.bot_nova.provider).toBe('template-fallback');
    expect(store.getState().botLogs.some((l) => l.level === 'warn' && l.botId === 'bot_nova')).toBe(true);
  });

  it('never calls fetch after the key is removed', async () => {
    await api.removeGeminiApiKey();
    expect(api.data().botSecrets.geminiApiKey).toBe('');
    const fetchFn = stubFetchOk();
    const reply = await api.demoBotReply('bot_sage', 'hello again');
    expect(reply).not.toBe(GEMINI_TEXT);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
