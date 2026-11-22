// Stage A multi-provider AI architecture: the provider registry, the
// router's chain/dedupe/quota/paid-gate behaviour, real usage shapes
// from both provider families, the health check, and the demo-mode
// end-to-end path (a Groq-backed bot post) through the REAL api.js.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AI_PROVIDERS, providerById, resolveAiConfig, generateRouted, testProvider,
  getLastRoutedFailure, resetLastRoutedFailure, dhakaDayKey, usageTotals,
  AI_ATTEMPT_TIMEOUT_MS, AI_TOTAL_TIMEOUT_MS
} from '../src/aiProviders.js';
import { generateGeminiDetailed } from '../src/gemini.js';
import { normaliseBot } from '../src/botLogic.js';
import * as V from '../src/views.js';

const nova = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', active: true,
  personality: { traits: ['curious', 'witty'], tone: 'bright and playful', interests: ['space', 'science'], systemPrompt: 'You are Nova, a curious AI bot on MeetBook.' },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 0 }
};

const config = (secrets = {}, platform = {}) => resolveAiConfig({ geminiApiKey: '', providers: {}, ...secrets }, platform);
const ALL_KEYS = config({
  geminiApiKey: 'GEM_KEY',
  providers: { groq: { apiKey: 'GROQ_KEY' }, openrouter: { apiKey: 'OR_KEY' }, cerebras: { apiKey: 'CER_KEY' } }
});

const openAiOk = (text, usage) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: text } }], usage, model: 'mock-model' })
});
const geminiOk = (text, usageMetadata) => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata })
});
const errRes = (status, message) => ({
  ok: false, status,
  json: async () => ({ error: { message } })
});

// Route a mocked fetch by host; handlers receive the parsed request.
function routedFetch(handlers) {
  return vi.fn(async (url, opts) => {
    const host = url.includes('api.groq.com') ? 'groq'
      : url.includes('openrouter.ai') ? 'openrouter'
        : url.includes('api.cerebras.ai') ? 'cerebras'
          : url.includes('router.huggingface.co') ? 'huggingface'
            : url.includes('generativelanguage.googleapis.com') ? 'gemini'
              : 'ollama';
    const h = handlers[host];
    if (!h) throw new Error(`unexpected fetch to ${host}: ${url}`);
    return typeof h === 'function' ? h(url, opts) : h;
  });
}
const urlsOf = (fetchImpl) => fetchImpl.mock.calls.map((c) => c[0]);

afterEach(() => { resetLastRoutedFailure(); vi.unstubAllGlobals(); });

describe('provider registry (verified free tiers)', () => {
  it('lists exactly the six providers with honest free status', () => {
    expect(AI_PROVIDERS.map((p) => p.id)).toEqual(['gemini', 'groq', 'openrouter', 'ollama', 'cerebras', 'huggingface']);
    expect(providerById('gemini').freeStatus).toBe('free');
    expect(providerById('groq').freeStatus).toBe('free');
    expect(providerById('openrouter').freeStatus).toBe('free');
    expect(providerById('ollama').freeStatus).toBe('self-hosted');
    expect(providerById('cerebras').freeStatus).toBe('paid-only');
    expect(providerById('huggingface').freeStatus).toBe('paid-only');
  });
  it('Groq lists ONLY its free models (no Llama) with the 1000/day cap', () => {
    const groq = providerById('groq');
    expect(groq.models).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
    expect(groq.models.join(' ')).not.toMatch(/llama/i);
    expect(groq.dailyCap).toBe(1000);
    expect(providerById('openrouter').dailyCap).toBe(50);
    expect(providerById('openrouter').defaultModel).toBe('openrouter/free');
    expect(providerById('gemini').dailyCap).toBeNull();
  });
});

describe('resolveAiConfig', () => {
  it('reads the Gemini key from its original top-level field', () => {
    const c = config({ geminiApiKey: '  ABC  ' });
    expect(c.providers.gemini.apiKey).toBe('ABC');
    expect(c.providers.gemini.defaultModel).toBe('gemini-3.5-flash');
  });
  it('defaults the fallback order and filters unknown ids', () => {
    expect(config().fallbackOrder).toEqual(['gemini', 'groq', 'openrouter']);
    expect(config({}, { aiFallbackOrder: ['groq', 'nope', 'groq', 'gemini'] }).fallbackOrder).toEqual(['groq', 'gemini']);
    expect(config().paidApproved).toBe(false);
    expect(config({}, { aiPaidApproved: true }).paidApproved).toBe(true);
  });
  it('honours per-provider enabled/defaultModel overrides', () => {
    const c = config({ providers: { groq: { apiKey: 'K', enabled: false, defaultModel: 'qwen/qwen3.8-27b' } } });
    expect(c.providers.groq.enabled).toBe(false);
    expect(c.providers.groq.defaultModel).toBe('qwen/qwen3.8-27b');
  });
});

describe('generateRouted chain', () => {
  it('tries the bot\'s own provider+model first, then the fallback order', async () => {
    const bot = { ...nova, provider: 'openrouter', model: 'some/model:free' };
    const fetchImpl = routedFetch({
      openrouter: errRes(500, 'upstream exploded'),
      gemini: geminiOk('from gemini', { promptTokenCount: 3, candidatesTokenCount: 2 })
    });
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: ALL_KEYS, fetchImpl });
    expect(res.provider).toBe('gemini');
    const urls = urlsOf(fetchImpl);
    expect(urls[0]).toContain('openrouter.ai');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('some/model:free');
    expect(urls[1]).toContain('generativelanguage.googleapis.com');
  });

  it('dedupes a (provider, model) pair: the bot\'s provider is attempted once', async () => {
    const bot = { ...nova, provider: 'groq', model: 'openai/gpt-oss-120b' }; // == groq default, also head of fallback below
    const cfg = config({ providers: { groq: { apiKey: 'G' }, openrouter: { apiKey: 'O' } } }, { aiFallbackOrder: ['groq', 'openrouter'] });
    const fetchImpl = routedFetch({
      groq: errRes(500, 'boom'),
      openrouter: openAiOk('from openrouter', { prompt_tokens: 5, completion_tokens: 4 })
    });
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl });
    expect(res.provider).toBe('openrouter');
    expect(urlsOf(fetchImpl).filter((u) => u.includes('api.groq.com'))).toHaveLength(1);
  });

  it('falls back on HTTP 500 and on HTTP 429', async () => {
    for (const status of [500, 429]) {
      const bot = { ...nova, provider: 'groq' };
      const fetchImpl = routedFetch({
        groq: errRes(status, 'nope'),
        openrouter: openAiOk(`recovered after ${status}`, { prompt_tokens: 1, completion_tokens: 1 })
      });
      const cfg = config({ providers: { groq: { apiKey: 'G' }, openrouter: { apiKey: 'O' } } }, { aiFallbackOrder: ['openrouter'] });
      const res = await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl });
      expect(res.text).toBe(`recovered after ${status}`);
      expect(res.provider).toBe('openrouter');
    }
  });

  it('a 429 marks the provider exhausted and later calls skip it without fetching', async () => {
    const attempts = [];
    const bot = { ...nova, provider: 'groq' };
    const cfg = config({ providers: { groq: { apiKey: 'G' }, openrouter: { apiKey: 'O' } } }, { aiFallbackOrder: ['openrouter'] });
    const fetchImpl = routedFetch({
      groq: errRes(429, 'Rate limit reached'),
      openrouter: openAiOk('ok', { prompt_tokens: 1, completion_tokens: 1 })
    });
    await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl, onAttempt: (id, a) => attempts.push([id, a]) });
    expect(attempts[0][0]).toBe('groq');
    expect(attempts[0][1].exhausted).toBe(true);
    expect(attempts[0][1].ok).toBe(false);

    const fetch2 = routedFetch({ openrouter: openAiOk('ok2', { prompt_tokens: 1, completion_tokens: 1 }) });
    const usageToday = { groq: { calls: 1, errors: 1, promptTokens: 0, completionTokens: 0, exhaustedUntil: Date.now() + 60_000 } };
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl: fetch2, usageToday });
    expect(res.provider).toBe('openrouter');
    expect(urlsOf(fetch2).some((u) => u.includes('api.groq.com'))).toBe(false);
  });

  it('quota guard: a provider at its daily cap is skipped without a request', async () => {
    const bot = { ...nova, provider: 'groq' };
    const cfg = config({ providers: { groq: { apiKey: 'G' }, openrouter: { apiKey: 'O' } } }, { aiFallbackOrder: ['openrouter'] });
    const fetchImpl = routedFetch({ openrouter: openAiOk('capped-out fallback', { prompt_tokens: 2, completion_tokens: 2 }) });
    const usageToday = { groq: { calls: 1000, errors: 0, promptTokens: 0, completionTokens: 0, exhaustedUntil: 0 } };
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl, usageToday });
    expect(res.provider).toBe('openrouter');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null and records a formatted failure when every attempt fails', async () => {
    const bot = { ...nova, provider: 'groq' };
    const cfg = config({ providers: { groq: { apiKey: 'G' } } }, { aiFallbackOrder: ['groq'] });
    const fetchImpl = routedFetch({ groq: errRes(503, 'Service unavailable, try later') });
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl });
    expect(res).toBeNull();
    expect(getLastRoutedFailure()).toBe('Groq — HTTP 503: Service unavailable, try later');
  });

  it('never sends a legacy Gemini model name to a non-Gemini primary', async () => {
    const bot = { ...nova, provider: '', model: 'gemini-3.8-flash' };
    const cfg = config({ providers: { groq: { apiKey: 'G' } } }, { aiFallbackOrder: ['groq'] });
    const fetchImpl = routedFetch({ groq: openAiOk('groq text', { prompt_tokens: 1, completion_tokens: 1 }) });
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl });
    expect(res.provider).toBe('groq');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('openai/gpt-oss-120b');
  });
});

// A fetch that never answers on its own: it settles only when the
// caller's AbortSignal fires, recording when each host's attempt
// started and aborted so the budget tests can measure the time each
// provider was actually given.
function hangingFetch(records) {
  return vi.fn((url, opts) => new Promise((_, reject) => {
    const host = url.includes('api.groq.com') ? 'groq'
      : url.includes('openrouter.ai') ? 'openrouter'
        : url.includes('generativelanguage.googleapis.com') ? 'gemini' : 'other';
    const rec = { host, startedAt: Date.now(), abortedAt: 0 };
    records.push(rec);
    const signal = opts?.signal;
    if (!signal) { rec.abortedAt = Date.now(); reject(new Error('no abort signal')); return; }
    signal.addEventListener('abort', () => {
      rec.abortedAt = Date.now();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
}

describe('generateRouted budgets + ordering hint', () => {
  const twoKeys = () => config(
    { providers: { groq: { apiKey: 'G' }, openrouter: { apiKey: 'O' } } },
    { aiFallbackOrder: ['groq'] }
  );

  it('ships a ~30s per-attempt budget inside a ~75s total budget', () => {
    expect(AI_ATTEMPT_TIMEOUT_MS).toBe(30_000);
    expect(AI_TOTAL_TIMEOUT_MS).toBe(75_000);
  });

  it('a later attempt still gets its OWN full per-attempt budget (no starvation)', async () => {
    const records = [];
    const bot = { ...nova, provider: 'openrouter' };
    const res = await generateRouted({
      bot, context: { kind: 'message' }, config: twoKeys(), fetchImpl: hangingFetch(records),
      timeoutMs: 90, totalTimeoutMs: 10_000
    });
    expect(res).toBeNull();
    expect(records.map((r) => r.host)).toEqual(['openrouter', 'groq']);
    // OpenRouter burned its full ~90ms; Groq — reached only after
    // that burn — was still given ~90ms of its own, not the scraps.
    expect(records[0].abortedAt - records[0].startedAt).toBeGreaterThanOrEqual(65);
    expect(records[1].abortedAt - records[1].startedAt).toBeGreaterThanOrEqual(65);
  });

  it('the total budget bounds the whole chain', async () => {
    const records = [];
    const bot = { ...nova, provider: 'openrouter' };
    const started = Date.now();
    const res = await generateRouted({
      bot, context: { kind: 'message' }, config: twoKeys(), fetchImpl: hangingFetch(records),
      timeoutMs: 90, totalTimeoutMs: 140
    });
    const elapsed = Date.now() - started;
    expect(res).toBeNull();
    expect(records.map((r) => r.host)).toEqual(['openrouter', 'groq']);
    // Groq was clipped to the ~50ms left of the total, and the call
    // ended at the total instead of running a fresh 90ms clock
    // (bounds carry slack for timer jitter under parallel test load;
    // a fresh-clock regression would push elapsed to ~180ms+).
    expect(records[1].abortedAt - records[1].startedAt).toBeLessThan(95);
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(200);
    expect(getLastRoutedFailure()).toBe('Groq — request failed: AbortError');
  });

  it('preferProviders leads with the hinted provider for this call', async () => {
    const bot = { ...nova, provider: 'openrouter' };
    const fetchImpl = routedFetch({ groq: openAiOk('fast groq', { prompt_tokens: 2, completion_tokens: 2 }) });
    const res = await generateRouted({ bot, context: { kind: 'message' }, config: ALL_KEYS, fetchImpl, preferProviders: ['groq'] });
    expect(res.provider).toBe('groq');
    expect(res.text).toBe('fast groq');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(urlsOf(fetchImpl)[0]).toContain('api.groq.com');
  });

  it('preferProviders reorders but never drops the rest of the chain', async () => {
    const bot = { ...nova, provider: 'openrouter' };
    const fetchImpl = routedFetch({
      groq: errRes(500, 'boom'),
      openrouter: openAiOk('router recovered', { prompt_tokens: 1, completion_tokens: 1 })
    });
    const res = await generateRouted({ bot, context: { kind: 'message' }, config: ALL_KEYS, fetchImpl, preferProviders: ['groq'] });
    expect(res.provider).toBe('openrouter');
    const urls = urlsOf(fetchImpl);
    expect(urls[0]).toContain('api.groq.com');
    expect(urls[1]).toContain('openrouter.ai');
  });

  it('unknown ids in preferProviders are ignored', async () => {
    const bot = { ...nova, provider: 'openrouter' };
    const fetchImpl = routedFetch({ openrouter: openAiOk('primary as usual', { prompt_tokens: 1, completion_tokens: 1 }) });
    const res = await generateRouted({ bot, context: { kind: 'message' }, config: ALL_KEYS, fetchImpl, preferProviders: ['nope'] });
    expect(res.provider).toBe('openrouter');
    expect(urlsOf(fetchImpl)[0]).toContain('openrouter.ai');
  });

  it('the Gemini model chain honours the router deadline instead of multiplying the budget', async () => {
    const records = [];
    const started = Date.now();
    const res = await generateGeminiDetailed({
      apiKey: 'GEM_KEY', bot: { name: 'Nova', model: 'gemini-3.5-flash' }, prompt: 'hi',
      fetchImpl: hangingFetch(records), timeoutMs: 10_000, deadlineAt: Date.now() + 120
    });
    const elapsed = Date.now() - started;
    expect(res).toBeNull();
    // One model attempted and clipped at the deadline; the chain did
    // NOT start a second model on a fresh 10s clock.
    expect(records).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('usage shapes', () => {
  it('reads Gemini usageMetadata into prompt/completion tokens', async () => {
    const fetchImpl = routedFetch({ gemini: geminiOk('hi', { promptTokenCount: 13, candidatesTokenCount: 5, totalTokenCount: 18 }) });
    const res = await generateRouted({ bot: nova, context: { kind: 'post' }, config: ALL_KEYS, fetchImpl });
    expect(res.provider).toBe('gemini');
    expect(res.model).toBe('gemini-3.5-flash');
    expect(res.usage).toEqual({ promptTokens: 13, completionTokens: 5 });
  });
  it('reads OpenAI-shaped usage from Groq', async () => {
    const bot = { ...nova, provider: 'groq' };
    const fetchImpl = routedFetch({ groq: openAiOk('hi', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) });
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: ALL_KEYS, fetchImpl });
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
    // The shared prompt carries the bot's personality to every provider.
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('You are Nova');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer GROQ_KEY');
  });
  it('usage is null when the provider reports none', async () => {
    const bot = { ...nova, provider: 'groq' };
    const fetchImpl = routedFetch({ groq: openAiOk('hi', undefined) });
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: ALL_KEYS, fetchImpl });
    expect(res.usage).toBeNull();
  });
  it('usageTotals sums real counters only', () => {
    expect(usageTotals({ groq: { calls: 2, errors: 1, promptTokens: 10, completionTokens: 5 }, gemini: { calls: 1, errors: 0, promptTokens: 3, completionTokens: 2 } }))
      .toEqual({ calls: 3, tokens: 20, errors: 1 });
  });
});

describe('paid gate', () => {
  it('the router never attempts a paid-only provider while approval is off', async () => {
    const bot = { ...nova, provider: 'cerebras', model: 'gpt-oss-120b' };
    // Fallback order contains ONLY cerebras: if the gate leaked, the
    // fetch below would answer and the result would be its text.
    const cfg = config({ providers: { cerebras: { apiKey: 'CER_KEY' } } }, { aiFallbackOrder: ['cerebras'] });
    const fetchImpl = routedFetch({ cerebras: openAiOk('paid text', { prompt_tokens: 1, completion_tokens: 1 }) });
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl });
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('with approval on, a paid provider behaves like any other', async () => {
    const bot = { ...nova, provider: 'cerebras', model: 'gpt-oss-120b' };
    const cfg = config({ providers: { cerebras: { apiKey: 'CER_KEY' } } }, { aiPaidApproved: true, aiFallbackOrder: ['cerebras'] });
    const fetchImpl = routedFetch({ cerebras: openAiOk('paid text', { prompt_tokens: 9, completion_tokens: 3 }) });
    const res = await generateRouted({ bot, context: { kind: 'post' }, config: cfg, fetchImpl });
    expect(res.provider).toBe('cerebras');
    expect(res.text).toBe('paid text');
  });
});

describe('testProvider (health check)', () => {
  it('reports ok on a real reply', async () => {
    const fetchImpl = routedFetch({ groq: openAiOk('OK', { prompt_tokens: 4, completion_tokens: 1 }) });
    const r = await testProvider('groq', { config: ALL_KEYS, fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('Groq');
    expect(r.usage).toEqual({ promptTokens: 4, completionTokens: 1 });
  });
  it('reports the provider\'s own error on failure', async () => {
    const fetchImpl = routedFetch({ groq: errRes(401, 'Invalid API Key') });
    const r = await testProvider('groq', { config: ALL_KEYS, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('HTTP 401');
    expect(r.detail).toContain('Invalid API Key');
  });
  it('refuses to call the network when no key is saved', async () => {
    const fetchImpl = vi.fn(async () => openAiOk('OK', undefined));
    const r = await testProvider('groq', { config: config(), fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('no API key saved');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('bot provider normalisation + day key', () => {
  it('normaliseBot keeps a trimmed lowercase provider, default empty', () => {
    expect(normaliseBot({ name: 'A', provider: ' Groq ' }).provider).toBe('groq');
    expect(normaliseBot({ name: 'A' }).provider).toBe('');
    expect(normaliseBot({ name: 'A', provider: 42 }).provider).toBe('');
  });
  it('dhakaDayKey formats yyyy-mm-dd', () => {
    expect(dhakaDayKey(Date.UTC(2026, 10, 19, 12, 0))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 2026-11-19 20:00 UTC is already 2026-11-20 02:00 in Dhaka (UTC+6).
    expect(dhakaDayKey(Date.UTC(2026, 10, 19, 20, 0))).toBe('2026-11-20');
  });
});

describe('botsView AI Providers section', () => {
  const NOW = Date.now();
  const botFixture = {
    id: 'bot_x', name: 'TestBot', username: 'test.bot', bio: '', avatar: '', model: '', provider: '', active: true,
    personality: { traits: ['calm'], tone: 'warm', interests: ['books'], systemPrompt: 'You are TestBot.' },
    limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 900000 },
    createdAt: NOW - 1000
  };
  const fixture = (over = {}) => ({
    users: [
      { id: 'u_admin', name: 'Admin', username: 'admin', role: 'admin', isBot: false },
      { id: 'bot_x', name: 'TestBot', username: 'test.bot', role: 'bot', isBot: true }
    ],
    bots: [botFixture],
    botBrains: {}, botMemories: { bot_x: [] }, botActivities: [], botLogs: [],
    botSettings: { global: { enabled: true }, counters: {} },
    botSecrets: { geminiApiKey: 'K', providers: { groq: { apiKey: 'G' } } },
    providerHealth: { groq: { ok: true, detail: 'Connected — Groq replied.', at: NOW - 60_000 } },
    botRunner: {},
    config: {},
    aiUsage: { day: '2026-11-20', providers: { groq: { calls: 3, errors: 1, promptTokens: 40, completionTokens: 12, exhaustedUntil: 0 } }, callsToday: 3, tokensToday: 52, updatedAt: NOW },
    ...over
  });

  it('renders a card per provider with badges, real usage and the health result', () => {
    const html = V.botsView(fixture(), null);
    expect(html).toContain('AI Providers');
    for (const label of ['Google Gemini', 'Groq', 'OpenRouter', 'Ollama', 'Cerebras', 'Hugging Face']) expect(html).toContain(label);
    expect(html).toContain('Paid — not connected');
    expect(html).toContain('data-provider-key-form="groq"');
    expect(html).toContain('data-provider-endpoint-form="ollama"');
    expect(html).toContain('<b>3</b> calls'); // groq real counters, not a nominal figure
    expect(html).toContain('<b>40</b> prompt + <b>12</b> completion tokens');
    expect(html).toContain('Connected — Groq replied.');
    expect(html).toContain('ai-fallback-form');
  });

  it('paid-only providers show NO key input while approval is off, and one when it is on', () => {
    const locked = V.botsView(fixture(), null);
    expect(locked).not.toContain('data-provider-key-form="cerebras"');
    expect(locked).toContain('one-time $5 trial credit');
    const unlocked = V.botsView(fixture({ config: { aiPaidApproved: true } }), null);
    expect(unlocked).toContain('data-provider-key-form="cerebras"');
  });

  it('the header usage line uses the real per-provider totals', () => {
    const html = V.botsView(fixture(), null);
    expect(html).toContain('3 calls · 52 tokens reported by providers');
    expect(html).not.toContain('~52');
  });

  it('bot form offers provider + model selects and a custom model input', () => {
    const html = V.botFormHtml({ ...botFixture, provider: 'groq', model: 'qwen/qwen3.8-27b' });
    expect(html).toContain('name="provider"');
    expect(html).toContain('value="groq" selected');
    expect(html).toContain('qwen/qwen3.8-27b');
    expect(html).toContain('name="modelCustom"');
    expect(html).not.toContain('llama-'); // Groq's free list has no Llama models (the Ollama label is fine)
  });
});
