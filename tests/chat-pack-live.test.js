import { describe, it, expect, vi, beforeAll } from 'vitest';

// Chat Pack — LIVE-mode (fake Supabase): reply snapshots persist on
// the message row, message reactions / pins patch the mirror
// immediately and land in the table, conversation theme persists on
// the conversation row, and typing rides the Phase 3 broadcast
// channel into the mirror's typing map — all on the existing
// participants contains sync, no new queries or indexes.

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

let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };
const mirrorMsg = (id) => api.data().messages.find((m) => m.id === id);
const mirrorConv = (id) => api.data().conversations.find((c) => c.id === id);

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'me@example.com': 'human1', 'friend@example.com': 'human2' };
  fake.seed('users', 'human1', { name: 'Mamun Hossen', username: 'your.name', email: 'me@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} });
  fake.seed('users', 'human2', { name: 'Ayesha Khan', username: 'ayesha', email: 'friend@example.com', role: 'user', isBot: false, followers: [], following: [], closeFriends: [], settings: {} });
  fake.seed('conversations', 'conv1', { participants: ['human1', 'human2'], createdAt: Date.now() - 60_000 });
  fake.seed('messages', 'msg1', {
    conversationId: 'conv1', participants: ['human1', 'human2'], senderId: 'human2',
    text: 'Hello from Ayesha', image: '', audio: '', createdAt: Date.now() - 30_000,
    status: 'sent', readBy: ['human2']
  });
  api = await import('../src/api.js');
  api.onAuthReady(() => {});
  await api.login('me@example.com', 'password123');
  await settle();
});

describe('live chat pack', () => {
  it('sendMessage persists the reply snapshot on the Firestore doc', async () => {
    const sent = await api.sendMessage('conv1', { text: 'Replying live', replyToId: 'msg1' });
    expect(sent.replyToId).toBe('msg1');
    const doc = fake.get('messages', sent.id);
    expect(doc.replyToId).toBe('msg1');
    expect(doc.replyToName).toBe('Ayesha Khan');
    expect(doc.replyToText).toBe('Hello from Ayesha');
    await settle();
    expect(mirrorMsg(sent.id).replyToText).toBe('Hello from Ayesha');
  });

  it('message reaction patches the mirror immediately and persists', async () => {
    const call = api.toggleMessageReaction('msg1', '❤️');
    expect(mirrorMsg('msg1').reactions).toEqual({ '❤️': ['human1'] }); // optimistic, pre-await
    await call;
    await settle();
    expect(fake.get('messages', 'msg1').reactions).toEqual({ '❤️': ['human1'] });
    await api.toggleMessageReaction('msg1', '❤️');
    await settle();
    expect(fake.get('messages', 'msg1').reactions).toEqual({});
  });

  it('pin toggles pinned/pinnedBy/pinnedAt on the Firestore doc', async () => {
    expect(await api.togglePinMessage('msg1')).toBe(true);
    await settle();
    const doc = fake.get('messages', 'msg1');
    expect(doc.pinned).toBe(true);
    expect(doc.pinnedBy).toBe('human1');
    expect(doc.pinnedAt).toBeGreaterThan(0);
    expect(mirrorMsg('msg1').pinned).toBe(true);
    expect(await api.togglePinMessage('msg1')).toBe(false);
    await settle();
    expect(fake.get('messages', 'msg1').pinned).toBe(false);
  });

  it('conversation theme persists on the conversation doc', async () => {
    await api.setConversationTheme('conv1', 'grape');
    await settle();
    expect(fake.get('conversations', 'conv1').theme).toBe('grape');
    expect(mirrorConv('conv1').theme).toBe('grape');
  });

  it('typing heartbeat updates the mirror typing map and clears it (Phase 3: broadcast, not a doc write)', async () => {
    await api.setTyping('conv1', true);
    await settle();
    // The indicator lives in the mirror's typing map (fed by the
    // broadcast channel + local state) with a fresh timestamp…
    const typing = mirrorConv('conv1').typing;
    expect(Math.abs(Date.now() - typing.human1)).toBeLessThan(5000);
    // …and is deliberately NOT persisted to the conversation row any
    // more: typing is heartbeat-only state on the Phase 3 channel.
    expect(fake.get('conversations', 'conv1').typing).toBeUndefined();
    await api.setTyping('conv1', false);
    await settle();
    expect(mirrorConv('conv1').typing.human1).toBeUndefined();
  });
});
