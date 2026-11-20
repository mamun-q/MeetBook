// Full Audit #2 (2026-11-21) — regression tests, demo/pure side:
//  V1 friendsView must not crash when a friendship references a
//     deleted/missing user (person() had no guard).
//  V2 message media URLs are scheme-checked at render: a crafted
//     javascript: file URL must never reach the href.
//  B5 Gemini usage accounting: one routed call can be up to 3 real
//     HTTP attempts (model chain) — the attempt count must be
//     reported truthfully to the usage counters.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { setLocale } from '../src/i18n.js';
import * as V from '../src/views.js';
import { generateGeminiDetailed, getLastGeminiAttempts, resetLastGeminiFailure } from '../src/gemini.js';
import { generateRouted, resolveAiConfig } from '../src/aiProviders.js';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: false, isFirebaseConfigured: false, firebaseConfig: {},
  app: null, auth: null, db: null, storage: null, googleProvider: null
}));

afterEach(() => { setLocale('en'); vi.unstubAllGlobals(); });

const NOW = Date.now();
const me = { id: 'u_me', name: 'Mamun Hossen', username: 'your.name', email: 'me@example.com', role: 'user', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 9000 };
const friend = { id: 'u_friend', name: 'Ayesha Khan', username: 'ayesha', email: 'friend@example.com', role: 'user', isBot: false, followers: [], following: [], settings: {}, createdAt: NOW - 9000 };
const baseData = (extra = {}) => ({
  users: [me, friend], posts: [], stories: [], groups: [], pages: [], friendships: [], blocks: [],
  notifications: [], events: [], reviews: [], groupRequests: [], conversations: [], messages: [],
  bots: [], botSettings: {}, botSecrets: {}, botRunner: {}, aiUsage: {}, config: { platformName: 'MeetBook' },
  announcements: [], adminLogs: [], reports: [], ...extra
});

describe('V1 friendsView — friendship with a deleted user', () => {
  it('renders instead of throwing when the other user is gone', () => {
    const d = baseData({
      friendships: [
        { id: 'f_ghost_in', from: 'u_deleted', to: 'u_me', status: 'pending', createdAt: NOW - 1000 },
        { id: 'f_ghost_friend', from: 'u_me', to: 'u_deleted', status: 'accepted', createdAt: NOW - 2000 },
        { id: 'f_ok', from: 'u_me', to: 'u_friend', status: 'accepted', createdAt: NOW - 3000 }
      ]
    });
    let html = '';
    expect(() => { html = V.friendsView(d, me); }).not.toThrow();
    expect(html).toContain('Ayesha Khan'); // the healthy friendship still renders
  });
});

describe('V2 message media URL scheme check', () => {
  const conv = { id: 'c1', participants: ['u_me', 'u_friend'], createdAt: NOW - 9000 };
  const render = (msg) => V.messagesView(baseData({
    conversations: [conv],
    messages: [{ id: 'm1', conversationId: 'c1', participants: ['u_me', 'u_friend'], senderId: 'u_friend', text: '', image: '', audio: '', createdAt: NOW - 1000, status: 'sent', readBy: ['u_friend'], ...msg }]
  }), me, 'c1');

  it('a javascript: file URL is neutralised', () => {
    const html = render({ file: { url: 'javascript:alert(1)', name: 'evil.txt', size: 10 } });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('msg-file');
  });
  it('an https file URL still renders as a download link', () => {
    const html = render({ file: { url: 'https://res.cloudinary.com/demo/raw/upload/f.txt', name: 'f.txt', size: 10 } });
    expect(html).toContain('https://res.cloudinary.com/demo/raw/upload/f.txt');
  });
  it('a data: audio URL (voice fallback) still renders', () => {
    const html = render({ audio: 'data:audio/webm;base64,AAAA' });
    expect(html).toContain('data:audio/webm;base64,AAAA');
  });
});

describe('B5 Gemini attempt counting', () => {
  const bot = { name: 'Nova', username: 'nova.bot', model: 'model-a', personality: { traits: [], tone: '', interests: [], systemPrompt: 'You are Nova.' } };
  const okJson = { candidates: [{ content: { parts: [{ text: 'hello' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } };
  const flakyFetch = () => vi.fn(async (url) => (
    String(url).includes('model-a')
      ? { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) }
      : { ok: true, status: 200, json: async () => okJson }
  ));

  it('generateGeminiDetailed reports the real number of HTTP attempts', async () => {
    resetLastGeminiFailure();
    const r = await generateGeminiDetailed({ apiKey: 'KEY', bot, prompt: 'hi', fetchImpl: flakyFetch() });
    expect(r).toBeTruthy();
    expect(r.text).toBe('hello');
    expect(r.attempts).toBe(2); // model-a failed, the default model answered
    expect(getLastGeminiAttempts()).toBe(2);
  });

  it('the router passes the true attempt count to onAttempt (usage accounting)', async () => {
    const config = resolveAiConfig({ geminiApiKey: 'KEY', providers: {} }, {});
    const seen = [];
    const res = await generateRouted({
      bot, memories: [], context: { kind: 'post' }, config, usageToday: {},
      fetchImpl: flakyFetch(), onAttempt: (id, attempt) => seen.push([id, attempt])
    });
    expect(res).toBeTruthy();
    expect(res.provider).toBe('gemini');
    const geminiAttempt = seen.find(([id]) => id === 'gemini');
    expect(geminiAttempt).toBeTruthy();
    expect(geminiAttempt[1].ok).toBe(true);
    expect(geminiAttempt[1].attempts).toBe(2);
  });
});
