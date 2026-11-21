import { describe, it, expect, vi, beforeAll } from 'vitest';
import { focusMovesWithinForm } from '../src/utils.js';
import * as V from '../src/views.js';

// Regression — the Messages composer's Send BUTTON did not send.
//
// Root cause (traced through the code): pressing the button moves focus
// off the text input first, so the Chat Pack's focusout listener
// (src/main.js) ran stopTyping() -> api.setTyping(conv, false) DURING
// the press. setTyping notifies the render listeners synchronously
// (live: patchRemoteConversation -> emitData 'meetbook:data'; demo:
// store.mutate -> subscribers), and softRender()'s don't-yank-focus
// guard no longer applies because focus has already left the input.
// render() therefore rebuilt the whole thread — destroying the form
// and the very button being pressed — before the click could submit
// it. The composer reappeared empty ("text clears") and no submit ever
// fired. Enter worked because implicit submission skips the blur.
//
// The fix: the focusout listener skips the typing clear when focus is
// moving to another control owned by the SAME form (the Send button,
// the emoji/voice buttons) — the send path and the idle timer clear
// the entry in those cases. That decision lives in the pure helper
// focusMovesWithinForm so it is testable here: this harness has no DOM
// event loop (node environment, main.js is never imported), so a true
// button click cannot be dispatched; these tests pin the decision
// predicate, the markup precondition it relies on, and the synchronous
// emit premise that made the blur-time clear destructive.

vi.mock('../src/supabase.js', () => ({
  supabaseReady: false, isSupabaseConfigured: false, supabaseConfig: {}, supabase: null
}));

describe('focusMovesWithinForm — the blur decision behind the fix', () => {
  it('a press on the form’s own Send button stays within the composer', () => {
    // focusout on the text input with relatedTarget = the submit
    // button: both elements are owned by #message-form, so the typing
    // entry must NOT be cleared mid-press.
    expect(focusMovesWithinForm('message-form', 'message-form')).toBe(true);
  });
  it('focus moving to a different form still clears typing', () => {
    expect(focusMovesWithinForm('message-form', 'search-form')).toBe(false);
  });
  it('focus going to a non-form element or nowhere still clears typing', () => {
    expect(focusMovesWithinForm('message-form', '')).toBe(false);
    expect(focusMovesWithinForm('message-form', undefined)).toBe(false);
    expect(focusMovesWithinForm('message-form', null)).toBe(false);
  });
  it('a formless blur source never counts as staying', () => {
    expect(focusMovesWithinForm('', 'message-form')).toBe(false);
    expect(focusMovesWithinForm(undefined, undefined)).toBe(false);
  });
});

// ------------------------------------------------------- markup premise
const NOW = Date.now();
const meUser = { id: 'u_me', name: 'Mamun Hossen', username: 'your.name', role: 'user', isBot: false, online: true, followers: [], following: [], closeFriends: [], settings: {}, createdAt: NOW - 9000 };
const friend = { id: 'u_friend', name: 'Ayesha Khan', username: 'ayesha', role: 'user', isBot: false, online: true, followers: [], following: [], settings: {}, createdAt: NOW - 9000 };

describe('composer markup — the precondition the blur guard relies on', () => {
  const d = {
    users: [meUser, friend],
    posts: [], stories: [], groups: [], pages: [], friendships: [], blocks: [],
    notifications: [], events: [], reviews: [], groupRequests: [],
    conversations: [{ id: 'c1', participants: ['u_me', 'u_friend'], createdAt: NOW - 9000 }],
    messages: [{ id: 'm1', conversationId: 'c1', participants: ['u_me', 'u_friend'], senderId: 'u_friend', text: 'Hi', image: '', audio: '', status: 'sent', readBy: [], createdAt: NOW - 1000 }]
  };
  it('the text input and the submit Send button share the one #message-form', () => {
    const html = V.messagesView(d, meUser, 'c1');
    const formBlock = html.match(/<form id="message-form"[\s\S]*?<\/form>/)?.[0] || '';
    expect(formBlock).toContain('name="text"');
    expect(formBlock).toContain('type="submit"');
    expect(formBlock.match(/type="submit"/g)).toHaveLength(1);
  });
});

// ------------------------------------------------- the destructive link
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

describe('premise — a typing clear notifies render listeners synchronously', () => {
  it('demo setTyping(false) fires store subscribers in the same task', async () => {
    const { subscribe } = await import('../src/store.js');
    let calls = 0;
    const off = subscribe(() => { calls += 1; });
    await api.setTyping('conv_1', true);
    const before = calls;
    const pending = api.setTyping('conv_1', false); // deliberately not awaited yet
    // The store emit (which main.js wires to softRender) has ALREADY
    // happened, synchronously, during the call — i.e. inside the
    // focusout dispatch of a button press, before click/submit.
    expect(calls).toBeGreaterThan(before);
    await pending;
    off();
  });
});
