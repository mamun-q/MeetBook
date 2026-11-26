import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  STICKER_PACKS, REACTION_EMOJI_SET, MESSAGE_REACTIONS, chatPollVote, chatPollTotal, nicknameFor, mapsUrl
} from '../src/utils.js';
import { findBotReplyTargets } from '../src/botLogic.js';
import { LOCALES, setLocale } from '../src/i18n.js';
import * as V from '../src/views.js';

// Messenger Fun Pack — stickers, any-emoji reactions, location
// sharing, chat polls and nicknames. Pure helpers, view rendering,
// i18n keys, the bot-reply guard, and the DEMO-mode api.

vi.mock('../src/supabase.js', () => ({
  supabaseReady: false, isSupabaseConfigured: false, supabaseConfig: {}, supabase: null
}));

afterEach(() => { setLocale('en'); });

// ------------------------------------------------------------ utils
describe('sticker packs + reaction set', () => {
  it('ships several packs of eight and a wider reaction set', () => {
    expect(STICKER_PACKS.length).toBeGreaterThanOrEqual(4);
    for (const p of STICKER_PACKS) expect(p.stickers.length).toBe(8);
    expect(REACTION_EMOJI_SET.length).toBeGreaterThan(MESSAGE_REACTIONS.length);
    expect(REACTION_EMOJI_SET).toContain('🔥');
  });
});

describe('chatPollVote', () => {
  const poll = { question: 'Tea or coffee?', options: [{ id: 'o1', text: 'Tea', votes: [] }, { id: 'o2', text: 'Coffee', votes: ['u2'] }] };
  it('votes, moves and withdraws — one vote per person, no mutation', () => {
    const v1 = chatPollVote(poll, 'o1', 'u1');
    expect(v1.options[0].votes).toEqual(['u1']);
    expect(poll.options[0].votes).toEqual([]); // input untouched
    const v2 = chatPollVote(v1, 'o2', 'u1');
    expect(v2.options[0].votes).toEqual([]);
    expect(v2.options[1].votes.sort()).toEqual(['u1', 'u2']);
    const v3 = chatPollVote(v2, 'o2', 'u1');
    expect(v3.options[1].votes).toEqual(['u2']);
    expect(chatPollTotal(v3)).toBe(1);
  });
});

describe('nicknameFor + mapsUrl', () => {
  it('prefers the nickname and falls back cleanly', () => {
    const conv = { nicknames: { u1: 'Boss' } };
    expect(nicknameFor(conv, 'u1', 'Real Name')).toBe('Boss');
    expect(nicknameFor(conv, 'u2', 'Real Name')).toBe('Real Name');
    expect(nicknameFor(null, 'u1', 'X')).toBe('X');
    expect(mapsUrl({ lat: 23.8103, lng: 90.4125 })).toContain('23.8103,90.4125');
  });
});

// ------------------------------------------------------------ bot guard
describe('findBotReplyTargets — contentless messages are skipped', () => {
  const convs = [{ id: 'c1', participants: ['bot', 'human'] }];
  it('skips sticker-only and unsent last messages, keeps text ones', () => {
    const sticker = { c1: { senderId: 'human', text: '', sticker: '😀' } };
    expect(findBotReplyTargets(convs, sticker, 'bot')).toEqual([]);
    const tomb = { c1: { senderId: 'human', text: '', unsent: true } };
    expect(findBotReplyTargets(convs, tomb, 'bot')).toEqual([]);
    const text = { c1: { senderId: 'human', text: 'hello' } };
    expect(findBotReplyTargets(convs, text, 'bot')).toHaveLength(1);
  });
});

// ------------------------------------------------------------ i18n
describe('i18n keys exist in both locales', () => {
  const keys = ['stickers', 'sticker', 'moreReactions', 'shareLocation', 'sharedLocation', 'openInMaps', 'locationShared', 'locationUnavailable', 'poll', 'createPoll', 'pollQuestion', 'pollOption', 'pollCreated', 'votes', 'nicknames', 'setNickname', 'nicknameSet', 'nicknameHint', 'optional'];
  it('covers every new key in en and bn', () => {
    for (const key of keys) {
      expect(LOCALES.en[key], `en:${key}`).toBeTruthy();
      expect(LOCALES.bn[key], `bn:${key}`).toBeTruthy();
    }
  });
});

// ------------------------------------------------------------- demo api
let api;
beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  };
  globalThis.document = { dispatchEvent: () => true };
  api = await import('../src/api.js');
  await api.login('ayesha@example.com', 'demo123');
});

describe('demo api — sticker / location / poll / nickname', () => {
  it('sends a sticker and a location as complete messages', async () => {
    const s = await api.sendMessage('conv_1', { sticker: '🎉' });
    expect(s.sticker).toBe('🎉');
    const loc = await api.sendMessage('conv_1', { location: { lat: 23.8103, lng: 90.4125 } });
    expect(loc.location).toEqual({ lat: 23.8103, lng: 90.4125 });
    await expect(api.sendMessage('conv_1', {})).rejects.toThrow();
  });
  it('runs a poll: create, vote, move, totals', async () => {
    const p = await api.sendMessage('conv_1', { poll: { question: 'Lunch?', options: [{ id: 'o1', text: 'Rice', votes: [] }, { id: 'o2', text: 'Biriyani', votes: [] }] } });
    await api.voteChatPoll(p.id, 'o1');
    let stored = api.data().messages.find((m) => m.id === p.id);
    expect(stored.poll.options[0].votes).toContain('u_ayesha');
    await api.voteChatPoll(p.id, 'o2');
    stored = api.data().messages.find((m) => m.id === p.id);
    expect(stored.poll.options[0].votes).not.toContain('u_ayesha');
    expect(stored.poll.options[1].votes).toContain('u_ayesha');
    await expect(api.voteChatPoll('m_nope', 'o1')).rejects.toThrow();
  });
  it('sets and clears a nickname', async () => {
    await api.setNickname('conv_1', 'bot_sage', 'Sage Vai');
    expect(api.data().conversations.find((c) => c.id === 'conv_1').nicknames.bot_sage).toBe('Sage Vai');
    await api.setNickname('conv_1', 'bot_sage', '');
    expect(api.data().conversations.find((c) => c.id === 'conv_1').nicknames.bot_sage).toBeUndefined();
  });
});

// ------------------------------------------------------------- views
describe('messagesView — fun pack rendering', () => {
  it('renders the sticker panel, composer buttons, sticker/location/poll bubbles and nicknames', async () => {
    const meUser = api.data().users.find((u) => u.id === 'u_ayesha');
    await api.sendMessage('conv_1', { sticker: '🦄' });
    await api.sendMessage('conv_1', { location: { lat: 23.8, lng: 90.4 } });
    await api.sendMessage('conv_1', { poll: { question: 'Best season?', options: [{ id: 'o1', text: 'Winter', votes: ['u_ayesha'] }, { id: 'o2', text: 'Monsoon', votes: [] }] } });
    await api.setNickname('conv_1', 'bot_sage', 'Captain');
    const html = V.messagesView(api.data(), meUser, 'conv_1');
    expect(html).toContain('id="sticker-panel"');
    expect(html).toContain('data-act="send-sticker"');
    expect(html).toContain('data-act="send-location"');
    expect(html).toContain('data-act="poll-open"');
    expect(html).toContain('msg-sticker');
    expect(html).toContain('msg-location');
    expect(html).toContain('chat-poll-option');
    expect(html).toContain('data-act="vote-poll"');
    expect(html).toContain('data-act="react-more"');
    expect(html).toContain('Captain'); // thread title uses the nickname
    // The nickname editor itself lives on the chat info page now.
    expect(V.chatInfoView(api.data(), meUser, 'conv_1')).toContain('data-act="set-nickname"');
  });
});
