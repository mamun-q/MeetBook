// Messenger thread stability (2026-11-22) — the thread "jumped up
// and down" on entering a conversation and on every data event.
//
// Root mechanisms (traced in src/main.js / src/api.js):
//  - render() rebuilds the whole app DOM per data event; the thread
//    was repositioned by a 30ms timer that UNCONDITIONALLY set
//    scrollTop = scrollHeight, so any emit (incoming message in any
//    chat, a typing heartbeat, a notification) rebuilt the thread at
//    scrollTop 0, flashed its top, then snapped to the bottom — and
//    yanked a user reading history straight to the tail.
//  - Typing patches emitted a data event per heartbeat even though
//    the typing row is refreshed by a 1s ticker by design.
//
// The fix carries the scroll position across rebuilds with the
// pinned/anchored model whose decisions are pure helpers in
// utils.js (pinned here), makes typing patches silent in api.js
// (pinned here by counting data events), and wires capture/restore
// into render()/setupThread (pinned here at source level, in the
// style of composer-send-blur — this harness has no DOM event loop,
// so main.js itself is never imported).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { isThreadPinned, pickScrollAnchor, anchoredScrollTop, threadRestoreMode, threadPinnedAfterScroll, THREAD_PIN_THRESHOLD_PX } from '../src/utils.js';

const rows = [
  { id: 'm1', top: 0, height: 100 },
  { id: 'm2', top: 110, height: 100 },
  { id: 'm3', top: 220, height: 100 },
  { id: 'm4', top: 330, height: 100 }
];

describe('isThreadPinned', () => {
  it('is pinned exactly at the bottom', () => {
    expect(isThreadPinned({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
  });
  it('is pinned within the threshold above the bottom', () => {
    expect(isThreadPinned({ scrollTop: 500 - THREAD_PIN_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
  });
  it('is not pinned beyond the threshold', () => {
    expect(isThreadPinned({ scrollTop: 500 - THREAD_PIN_THRESHOLD_PX - 1, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
  });
  it('a thread shorter than its viewport counts as pinned', () => {
    expect(isThreadPinned({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 })).toBe(true);
  });
});

describe('pickScrollAnchor / anchoredScrollTop', () => {
  it('anchors to the first row whose bottom edge is past scrollTop, with the intra-row offset', () => {
    expect(pickScrollAnchor(rows, 150)).toEqual({ id: 'm2', offset: 40 });
    expect(pickScrollAnchor(rows, 0)).toEqual({ id: 'm1', offset: 0 });
  });
  it('a scrollTop inside the inter-row gap anchors to the next row with a negative offset', () => {
    // 105 sits in the 10px gap between m1 (ends 100) and m2 (starts 110).
    expect(pickScrollAnchor(rows, 105)).toEqual({ id: 'm2', offset: -5 });
  });
  it('returns null when scrolled past every row', () => {
    expect(pickScrollAnchor(rows, 9999)).toBeNull();
    expect(pickScrollAnchor([], 0)).toBeNull();
  });
  it('restores the same scrollTop from the same layout (round trip)', () => {
    const anchor = pickScrollAnchor(rows, 150);
    expect(anchoredScrollTop(rows, anchor)).toBe(150);
  });
  it('compensates when rows above the anchor grow (image loaded): same row, same offset, shifted top', () => {
    const anchor = pickScrollAnchor(rows, 150); // reading m2 at offset 40
    const grown = [
      { id: 'm1', top: 0, height: 360 }, // m1's photo loaded: +260px
      { id: 'm2', top: 370, height: 100 },
      { id: 'm3', top: 480, height: 100 },
      { id: 'm4', top: 590, height: 100 }
    ];
    expect(anchoredScrollTop(grown, anchor)).toBe(410); // 370 + 40 — m2 stays exactly under the eye
  });
  it('returns null for a missing anchor row (message deleted/unsent) so the caller can clamp', () => {
    expect(anchoredScrollTop(rows, { id: 'gone', offset: 10 })).toBeNull();
    expect(anchoredScrollTop(rows, null)).toBeNull();
  });
});

// Phone round 2 (2026-11-22): realtime now actually delivers, and
// the remaining jumps were geometry ones — the browser chrome and
// the keyboard keep RESIZING the thread box, and a resize fires
// scroll events whose metrics would read a tail-glued user as
// "scrolled up" (box shrank → distance-to-bottom over threshold).
// threadPinnedAfterScroll is the decision main.js feeds with the
// previous intent + the box height at the previous event.
describe('threadPinnedAfterScroll', () => {
  const atTail = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };
  it('same box height: the raw metrics decide (at the tail → pinned)', () => {
    expect(threadPinnedAfterScroll({ wasPinned: false, clientHeightBefore: 500, ...atTail })).toBe(true);
  });
  it('same box height: scrolled up beyond the threshold → not pinned', () => {
    expect(threadPinnedAfterScroll({ wasPinned: true, clientHeightBefore: 500, scrollTop: 100, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
  });
  it('box SHRANK (keyboard/chrome): a pinned user stays pinned even though the metrics now read far from the bottom', () => {
    // clientHeight 500 → 300: distance-to-bottom is now 200px, way
    // past the 48px threshold — the raw check would unglue them.
    expect(threadPinnedAfterScroll({ wasPinned: true, clientHeightBefore: 500, scrollTop: 500, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
  });
  it('box GREW (chrome hid): a pinned user stays pinned', () => {
    expect(threadPinnedAfterScroll({ wasPinned: true, clientHeightBefore: 300, scrollTop: 500, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
  });
  it('box changed: an anchored (reading) user stays anchored — a resize never pins either', () => {
    expect(threadPinnedAfterScroll({ wasPinned: false, clientHeightBefore: 500, ...atTail, clientHeight: 300 })).toBe(false);
  });
  it('no previous intent (first capture): falls back to the raw metrics even when the height differs', () => {
    expect(threadPinnedAfterScroll({ wasPinned: null, clientHeightBefore: 500, scrollTop: 500, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
    expect(threadPinnedAfterScroll({ wasPinned: undefined, clientHeightBefore: null, ...atTail })).toBe(true);
  });
});

describe('threadRestoreMode', () => {
  it('fresh open (no capture) goes to the bottom', () => {
    expect(threadRestoreMode(null, 'c1')).toBe('bottom');
  });
  it('a different conversation than captured goes to the bottom', () => {
    expect(threadRestoreMode({ convId: 'c1', pinned: false, anchor: { id: 'm1', offset: 0 } }, 'c2')).toBe('bottom');
  });
  it('a pinned capture stays at the bottom', () => {
    expect(threadRestoreMode({ convId: 'c1', pinned: true, anchor: null }, 'c1')).toBe('bottom');
  });
  it('an anchored capture for the same conversation restores the anchor', () => {
    expect(threadRestoreMode({ convId: 'c1', pinned: false, anchor: { id: 'm2', offset: 40 } }, 'c1')).toBe('anchor');
  });
});

// ------------------------------------------------------------ api: typing
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
let dataEvents = 0;
globalThis.document = { dispatchEvent: (e) => { if (e && e.type === 'meetbook:data') dataEvents++; return true; } };

let api;
let fake;
const settle = async () => { await new Promise((r) => setTimeout(r, 15)); await new Promise((r) => setTimeout(r, 15)); };

beforeAll(async () => {
  fake = (await import('./fake-supabase.js')).fakeControl;
  fake.reset();
  fake.usersByEmail = { 'me@example.com': 'human1', 'friend@example.com': 'human2' };
  const userRow = (name, username, email) => ({
    name, username, email, role: 'user', isBot: false, bio: '', avatar: '', cover: '',
    followers: [], following: [], closeFriends: [], settings: {}
  });
  fake.seed('users', 'human1', userRow('Mamun Hossen', 'your.name', 'me@example.com'));
  fake.seed('users', 'human2', userRow('Ayesha Khan', 'ayesha', 'friend@example.com'));
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

describe('typing patches are silent (live mode)', () => {
  it('setTyping updates the mirror typing state WITHOUT dispatching a data event', async () => {
    dataEvents = 0;
    await api.setTyping('conv1', true);
    const conv = api.data().conversations.find((c) => c.id === 'conv1');
    expect(conv.typing?.human1).toBeGreaterThan(0); // the mirror DID update (ticker will show it)
    expect(dataEvents).toBe(0); // …but no full re-render was triggered
    await api.setTyping('conv1', false);
    const conv2 = api.data().conversations.find((c) => c.id === 'conv1');
    expect(conv2.typing?.human1).toBeUndefined();
    expect(dataEvents).toBe(0);
  });
});

// ------------------------------------------------------------ main.js wiring
describe('main.js thread-stability wiring (source pins)', () => {
  const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

  it('render() captures the thread state before rebuilding and restores it for the messages route', () => {
    expect(mainSrc).toContain('captureThreadView();');
    expect(mainSrc).toContain("if (route === 'messages') restoreThreadView();");
    // Capture must precede the shell swap it protects.
    expect(mainSrc.indexOf('captureThreadView();')).toBeLessThan(mainSrc.indexOf('appEl.innerHTML = `'));
  });

  it('setupThread restores (never force-scrolls) and re-applies on image load + scroll', () => {
    const setup = mainSrc.slice(mainSrc.indexOf('function setupThread()'), mainSrc.indexOf('function setupThread()') + 1200);
    expect(setup).toContain('restoreThreadView();');
    expect(setup).not.toContain('scrollThread();');
    expect(setup).toContain("addEventListener('load'");
    expect(setup).toContain("addEventListener('scroll', refreshThreadIntent");
  });

  it('panel toggles re-apply the scroll intent instead of forcing the bottom', () => {
    expect(mainSrc).toContain("case 'emoji-toggle': { const panel = document.getElementById('emoji-panel'); panel?.classList.toggle('hidden'); if (panel && !panel.classList.contains('hidden')) applyThreadScroll(); break; }");
    expect(mainSrc).toContain("case 'sticker-toggle': { const panel = document.getElementById('sticker-panel'); panel?.classList.toggle('hidden'); if (panel && !panel.classList.contains('hidden')) applyThreadScroll(); break; }");
  });
});

// ------------------------------------------------ phone round 2 wiring
describe('phone geometry glue (main.js + styles.css source pins)', () => {
  const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

  it('capture decides the pin resize-aware (threadPinnedAfterScroll)', () => {
    expect(mainSrc).toContain('threadPinnedAfterScroll({');
  });

  it('a resize-driven scroll event carries the intent over untouched', () => {
    expect(mainSrc).toContain('if (resized && threadIntent && threadIntent.convId === convId) return;');
  });

  it('thread images re-apply the intent on load from a document-level capture listener (no setupThread gap)', () => {
    expect(mainSrc).toContain("e.target.closest?.('#thread-body')");
  });

  it('viewport resizes (chrome + keyboard, incl. visualViewport-only) re-apply the intent', () => {
    expect(mainSrc).toContain("window.addEventListener('resize', () => applyThreadScroll());");
    expect(mainSrc).toContain("window.visualViewport?.addEventListener('resize', () => applyThreadScroll());");
  });

  it('a ResizeObserver on the thread box re-applies the intent when the box itself resizes', () => {
    expect(mainSrc).toContain('new ResizeObserver(() => applyThreadScroll())');
  });

  it('restore re-applies once more on the next animation frame (late first-frame settle)', () => {
    expect(mainSrc).toContain('requestAnimationFrame(() => applyThreadScroll())');
  });

  it('render() marks an open chat on the body for the mobile app-shell CSS', () => {
    expect(mainSrc).toContain("classList.toggle('chat-open'");
  });

  it('mobile chat-open CSS: page locked, thread the only scroller (no vh max-height)', () => {
    expect(css).toContain('body.chat-open { overflow: hidden; }');
    expect(css).toContain('body.chat-open .thread-body { flex: 1; min-height: 0; max-height: none; }');
    expect(css).toContain('height: 100dvh');
  });

  it('thread and conversation list contain their own overscroll (no chaining to the page)', () => {
    expect(css).toContain('overscroll-behavior: contain');
  });
});
