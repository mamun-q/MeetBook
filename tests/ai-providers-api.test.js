// Stage A at the api.js level (demo mode, firebase mocked off — the
// gemini-wiring pattern): the paid gate on key saves, per-provider key
// storage, platform settings for the fallback order / paid approval,
// and an end-to-end demo cycle where a Groq-backed bot post is stamped
// generatedBy 'groq' with REAL usage counters recorded.
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
const GROQ_TEXT = 'Groq-generated text from the Stage A test';

function stubGroqFetch() {
  const fn = vi.fn(async (url) => {
    if (String(url).includes('api.groq.com')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: GROQ_TEXT } }],
          usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
          model: 'openai/gpt-oss-120b'
        })
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeAll(async () => {
  store = await import('../src/store.js');
  api = await import('../src/api.js');
  await api.login('admin@meetbook.app', 'admin123');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('provider key management + paid gate', () => {
  it('rejects a Cerebras key while paid approval is off, accepts it once approved', async () => {
    await expect(api.saveProviderKey('cerebras', 'CER_KEY')).rejects.toThrow(/paid provider/i);
    expect(api.data().botSecrets.providers?.cerebras?.apiKey || '').toBe('');
    await api.adminSavePlatformSettings({ aiPaidApproved: true });
    expect(api.data().config.aiPaidApproved).toBe(true);
    await api.saveProviderKey('cerebras', 'CER_KEY');
    expect(api.data().botSecrets.providers.cerebras.apiKey).toBe('CER_KEY');
    await api.adminSavePlatformSettings({ aiPaidApproved: false });
    await api.removeProviderKey('cerebras');
    expect(api.data().botSecrets.providers.cerebras.apiKey).toBe('');
  });

  it('stores and removes a Groq key; unknown providers and empty keys are rejected', async () => {
    await expect(api.saveProviderKey('groq', '   ')).rejects.toThrow(/Paste a Groq API key/);
    await expect(api.saveProviderKey('nope', 'x')).rejects.toThrow(/Unknown AI provider/);
    await api.saveProviderKey('groq', 'GROQ_KEY');
    expect(api.data().botSecrets.providers.groq.apiKey).toBe('GROQ_KEY');
  });

  it('validates the fallback order through platform settings', async () => {
    const clean = await api.adminSavePlatformSettings({ aiFallbackOrder: ['groq', 'bogus', 'gemini', 'groq'] });
    expect(clean.aiFallbackOrder).toEqual(['groq', 'gemini']);
    expect(api.data().config.aiFallbackOrder).toEqual(['groq', 'gemini']);
    await api.adminSavePlatformSettings({ aiFallbackOrder: ['gemini', 'groq', 'openrouter'] });
  });

  it('validates the Ollama endpoint and provider enable toggles', async () => {
    await expect(api.saveProviderEndpoint('not a url')).rejects.toThrow(/valid endpoint URL/);
    await api.saveProviderEndpoint('http://localhost:11434/v1/');
    expect(api.data().botSecrets.providers.ollama.endpoint).toBe('http://localhost:11434/v1');
    await api.setProviderEnabled('ollama', false);
    expect(api.data().botSecrets.providers.ollama.enabled).toBe(false);
    await api.setProviderEnabled('ollama', true);
  });

  it('removing the Gemini key no longer wipes the other providers', async () => {
    await api.saveGeminiApiKey('GEM_KEY');
    await api.removeGeminiApiKey();
    expect(api.data().botSecrets.geminiApiKey).toBe('');
    expect(api.data().botSecrets.providers.groq.apiKey).toBe('GROQ_KEY');
  });
});

describe('demo cycle with a Groq-backed bot', () => {
  it('posts generatedBy groq and records real per-provider usage', async () => {
    const nova = store.getState().bots.find((b) => b.id === 'bot_nova');
    await api.saveBot({ ...nova, provider: 'groq', model: '' });
    const fetchFn = stubGroqFetch();
    const r = await api.runDemoBotCycle();
    expect(r.ran).toBe(true);
    const post = store.getState().posts.find((p) => p.authorId === 'bot_nova');
    expect(post.text).toContain(GROQ_TEXT);
    expect(post.generatedBy).toBe('groq');
    const brain = store.getState().botBrains.bot_nova;
    expect(brain.provider).toBe('groq');
    expect(brain.model).toBe('openai/gpt-oss-120b');
    // Real counters from the provider's own usage fields.
    const usage = store.getState().aiUsage;
    expect(usage.providers.groq.calls).toBeGreaterThanOrEqual(1);
    expect(usage.providers.groq.promptTokens).toBeGreaterThanOrEqual(21);
    expect(usage.providers.groq.completionTokens).toBeGreaterThanOrEqual(9);
    expect(usage.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fetchFn.mock.calls.every((c) => String(c[0]).includes('api.groq.com'))).toBe(true);
  });

  it('testProviderConnection records the health result for the panel', async () => {
    stubGroqFetch();
    const health = await api.testProviderConnection('groq');
    expect(health.ok).toBe(true);
    expect(api.data().providerHealth.groq.ok).toBe(true);
    const blocked = await api.testProviderConnection('openrouter');
    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toContain('no API key saved');
  });
});
