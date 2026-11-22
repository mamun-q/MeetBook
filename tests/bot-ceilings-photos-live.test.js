// Live-cycle coverage for two 2026-11-22 owner orders:
//  A) Platform-wide daily ceilings on bot posts/comments
//     (BOT_GLOBAL_POSTS_PER_DAY / BOT_GLOBAL_COMMENTS_PER_DAY): once
//     ALL bots together hit the ceiling, no bot posts or comments
//     again that Dhaka day — likes (and DMs) still flow.
//  B) Companion photo album: a bot with personality.album (Anika),
//     DMing with the platform OWNER, who asks for a photo, sends the
//     next album photo as an image message — rule-based, so it works
//     in template-fallback mode too — rotating without repeats, one
//     message-cap slot per send, and NEVER for anyone else or for
//     talk that merely mentions photos.
// Same harness as live-bot-runner.test.js: the REAL api.js against
// the in-memory fake Supabase.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

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

import {
  BOT_GLOBAL_POSTS_PER_DAY, BOT_GLOBAL_COMMENTS_PER_DAY,
  BOT_OWNER_ID, counterDayKey, emptyBotCounters
} from '../src/botLogic.js';

let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

const ADMIN = { name: 'MeetBook Admin', username: 'admin', email: 'admin@meetbook.app', role: 'admin', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const OWNER = { name: 'Mamun Hossen', username: 'md.mamun', email: 'owner@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const HUMAN2 = { name: 'Rafi Human', username: 'rafi', email: 'rafi@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} };
const NOVA = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', avatar: '', bio: '',
  isBot: true, active: true,
  personality: { traits: ['curious', 'witty'], tone: 'bright and playful', interests: ['space', 'science'], systemPrompt: 'You are Nova.' },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 15 * 60 * 1000 },
  createdAt: Date.now() - 20 * 24 * 3600_000
};
const ALBUM = ['https://img.test/anika-1.jpg', 'https://img.test/anika-2.jpg', 'https://img.test/anika-3.jpg'];
const ANIKA = {
  id: 'bot_anika', name: 'Anika', username: 'anika.rahman', avatar: '', bio: '',
  isBot: true, active: true,
  personality: { traits: ['loving'], tone: 'romantic', interests: ['songs'], systemPrompt: 'You are Anika.', album: ALBUM },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 0 },
  createdAt: Date.now() - 20 * 24 * 3600_000
};

function stubFetchOffline() {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
}

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'admin@meetbook.app': 'admin1' };
  fake.seed('users', 'admin1', ADMIN);
  fake.seed('users', BOT_OWNER_ID, OWNER);
  fake.seed('users', 'human2', HUMAN2);
  fake.seed('bots', 'bot_nova', NOVA);
  fake.seed('bots', 'bot_anika', ANIKA);
  fake.seed('botSettings', 'global', { enabled: true });
  fake.seed('botSecrets', 'config', { geminiApiKey: 'TEST_KEY' });
  fake.seed('posts', 'post1', {
    authorId: 'human2', text: 'Hello world from Rafi', image: '', visibility: 'public', audienceIds: [],
    createdAt: Date.now() - 60_000, editedAt: 0, likes: [], reactions: {}, comments: [], shares: 0,
    sharedFrom: '', savedBy: [], groupId: '', pageId: '', pageName: '', pageAvatar: '', poll: null, location: '', feeling: '', pinned: false
  });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('admin@meetbook.app', 'admin123');
  await settle();
  api.stopBotRunner(); // deterministic manual cycles only
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('live cycle: global ceilings + companion album', () => {
  it('A: at the global ceiling no bot posts or comments, but likes still flow', async () => {
    // Other (not-running) bots have already used up today's platform
    // allowance — the counters doc is the shared source both cycles
    // read, keyed to the same Dhaka day as the per-bot caps.
    fake.seed('botSettings', 'counters', {
      day: counterDayKey(),
      counters: {
        bot_elsewhere1: { ...emptyBotCounters(), postsToday: BOT_GLOBAL_POSTS_PER_DAY },
        bot_elsewhere2: { ...emptyBotCounters(), commentsToday: BOT_GLOBAL_COMMENTS_PER_DAY }
      }
    });
    stubFetchOffline();
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    // No bot authored a post, and the one public post got no comment…
    expect(fake.all('posts').filter((p) => String(p.authorId).startsWith('bot_'))).toHaveLength(0);
    expect(fake.get('posts', 'post1').comments).toHaveLength(0);
    // …but Nova's like still landed (likes are never ceilinged).
    expect(fake.get('posts', 'post1').likes).toContain('bot_nova');
    const novaCounters = fake.get('botSettings', 'counters').counters.bot_nova;
    expect(novaCounters.postsToday).toBe(0);
    expect(novaCounters.commentsToday).toBe(0);
    expect(novaCounters.likesToday).toBe(1);
    expect(r.results.some((x) => x.bot === 'Nova' && x.action === 'like')).toBe(true);
    expect(r.results.some((x) => x.action === 'post' || x.action === 'comment' || x.action === 'comment-reply')).toBe(false);
  });

  it('B: owner asks for a photo -> text reply + first album photo, even in template mode', async () => {
    fake.remove('botSettings', 'counters'); // fresh day for the DM tests
    fake.seed('conversations', 'conv_photo', { participants: [BOT_OWNER_ID, 'bot_anika'], createdAt: Date.now() - 50_000 });
    fake.seed('messages', 'req1', {
      conversationId: 'conv_photo', participants: [BOT_OWNER_ID, 'bot_anika'], senderId: BOT_OWNER_ID,
      text: 'জান, তোমার একটা ছবি দাও না', image: '', audio: '', createdAt: Date.now() - 40_000, status: 'sent', readBy: [BOT_OWNER_ID]
    });
    stubFetchOffline(); // every provider down -> template fallback; the photo must STILL go
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    const sent = fake.all('messages').filter((m) => m.conversationId === 'conv_photo' && m.senderId === 'bot_anika');
    const photo = sent.find((m) => m.image);
    expect(photo).toBeTruthy();
    expect(photo.image).toBe(ALBUM[0]); // rotation starts at the top of the album
    expect(photo.text.length).toBeGreaterThan(3); // affectionate caption rides as the message text
    const textReply = sent.find((m) => !m.image && m.text);
    expect(textReply).toBeTruthy(); // the text reply rides alongside (cap had room)
    // Two sends, two message-cap slots consumed.
    expect(fake.get('botSettings', 'counters').counters.bot_anika.messagesToday).toBe(2);
    expect(r.results.some((x) => x.bot === 'Anika' && x.action === 'photo')).toBe(true);
  });

  it('B: a second ask rotates to the NEXT album photo (no repeat)', async () => {
    fake.seed('messages', 'req2', {
      conversationId: 'conv_photo', participants: [BOT_OWNER_ID, 'bot_anika'], senderId: BOT_OWNER_ID,
      // Slightly future-dated so it is unambiguously the conversation's
      // latest message (the bot's own B-1 replies carry real Date.now()).
      text: 'আরেকটা ছবি পাঠাও তো', image: '', audio: '', createdAt: Date.now() + 2000, status: 'sent', readBy: [BOT_OWNER_ID]
    });
    stubFetchOffline();
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    const photos = fake.all('messages').filter((m) => m.conversationId === 'conv_photo' && m.senderId === 'bot_anika' && m.image);
    expect(photos.map((m) => m.image)).toEqual([ALBUM[0], ALBUM[1]]);
    expect(fake.get('botSettings', 'counters').counters.bot_anika.messagesToday).toBe(4);
  });

  it('B: a NON-owner asking for a photo gets a text reply only — never a photo', async () => {
    // Retire the photo conversation: req2 stays its latest-by-timestamp
    // message (future-dated), so without this the cycle would keep
    // answering there instead of in the new conversation.
    fake.remove('conversations', 'conv_photo');
    fake.seed('conversations', 'conv_other', { participants: ['human2', 'bot_anika'], createdAt: Date.now() - 30_000 });
    fake.seed('messages', 'req3', {
      conversationId: 'conv_other', participants: ['human2', 'bot_anika'], senderId: 'human2',
      text: 'তোমার একটা ছবি দাও', image: '', audio: '', createdAt: Date.now(), status: 'sent', readBy: ['human2']
    });
    stubFetchOffline();
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    const sent = fake.all('messages').filter((m) => m.conversationId === 'conv_other' && m.senderId === 'bot_anika');
    expect(sent).toHaveLength(1);
    expect(sent[0].image).toBeFalsy();
    expect(sent[0].text.length).toBeGreaterThan(3);
    // Her last cap slot (4 -> 5) went to that text reply.
    expect(fake.get('botSettings', 'counters').counters.bot_anika.messagesToday).toBe(5);
  });

  it('B: the owner merely TALKING about photos gets no photo send', async () => {
    fake.remove('botSettings', 'counters'); // Anika was at her message cap after the previous test
    fake.remove('conversations', 'conv_other'); // answered above; keep it out of target discovery
    fake.seed('conversations', 'conv_chat', { participants: [BOT_OWNER_ID, 'bot_anika'], createdAt: Date.now() - 20_000 });
    fake.seed('messages', 'req4', {
      conversationId: 'conv_chat', participants: [BOT_OWNER_ID, 'bot_anika'], senderId: BOT_OWNER_ID,
      text: 'আমি আজ একটা সুন্দর ছবি তুললাম', image: '', audio: '', createdAt: Date.now(), status: 'sent', readBy: [BOT_OWNER_ID]
    });
    stubFetchOffline();
    const r = await api.runBotCycle();
    expect(r.ran).toBe(true);
    const sent = fake.all('messages').filter((m) => m.conversationId === 'conv_chat' && m.senderId === 'bot_anika');
    expect(sent).toHaveLength(1);
    expect(sent[0].image).toBeFalsy();
    expect(sent[0].text.length).toBeGreaterThan(3);
  });
});
