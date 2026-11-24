// Reaction popup (2026-11-25) — Facebook pattern, owner's choice.
//
// Owner complaint (Firefox for Android): every post permanently
// rendered a reaction emoji row (❤️ 😆 😮 😢 👏) under the
// Like/Comment/Share bar — a full row eaten on every phone card, heavy
// and cluttered. The fix removes the in-card row entirely: a plain tap
// on Like still likes, and a LONG-PRESS on Like opens ONE floating
// popup (a single element in document.body, outside #app, so feed
// re-renders cannot wipe it) whose picks route through the existing
// data-act="react" → toggleReaction flow.
//
// The gesture decisions are pure (utils.createLongPress) and pinned
// behaviourally here; the popup markup builder is a components.js
// export and pinned the same way; main.js wiring (which this harness
// never imports) is pinned at source level, in the style of
// press-render-gate / composer-send-blur.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLongPress, LONG_PRESS_MS, LONG_PRESS_MOVE_PX } from '../src/utils.js';
import { postCardHtml, reactionButtonsHtml, REACTION_EMOJIS } from '../src/components.js';

const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('post card — no permanent reaction row', () => {
  const meUser = { id: 'me', name: 'Me', username: 'me' };
  const author = { id: 'a1', name: 'Asha', username: 'asha' };
  const ctx = { me: meUser, usersById: { me: meUser, a1: author }, friendIds: new Set(), pagesById: {}, groupsById: {} };
  const basePost = {
    id: 'p1', authorId: 'a1', text: 'hi', image: '', visibility: 'public',
    likes: [], reactions: {}, comments: [], shares: 0, savedBy: [], createdAt: Date.now()
  };

  it('renders no reaction row and no react buttons, even with reactions present', () => {
    const html = postCardHtml({ ...basePost, reactions: { u1: '😆', me: '❤️' } }, ctx);
    expect(html).not.toContain('reaction-bar');
    expect(html).not.toContain('data-act="react"');
  });

  it('keeps the Like / Comment / Share bar intact', () => {
    const html = postCardHtml(basePost, ctx);
    expect(html).toContain('data-act="like"');
    expect(html).toContain('data-act="focus-comment"');
    expect(html).toContain('data-act="share"');
  });

  it('keeps the combined reaction total in the stats line', () => {
    const html = postCardHtml({ ...basePost, reactions: { u1: '😆', u2: '😆' } }, ctx);
    expect(html).toContain('😆 2');
  });
});

describe('reactionButtonsHtml — the popup picker markup', () => {
  it('renders exactly the five reactions as data-act="react" buttons', () => {
    const html = reactionButtonsHtml('');
    for (const e of REACTION_EMOJIS) {
      expect(html).toContain(`data-act="react" data-emoji="${e}"`);
    }
    expect((html.match(/<button/g) || []).length).toBe(5);
    expect(html).not.toContain('active');
  });

  it('highlights only the viewer’s current reaction', () => {
    const html = reactionButtonsHtml('😮');
    const active = html.match(/<button[^>]*active[^>]*>/g) || [];
    expect(active.length).toBe(1);
    expect(active[0]).toContain('data-emoji="😮"');
  });
});

describe('createLongPress — the hold decisions', () => {
  it('a hold that stays put matures on fire()', () => {
    const lp = createLongPress();
    lp.begin(100, 200);
    expect(lp.tracking).toBe(true);
    expect(lp.fire()).toBe(true);
    expect(lp.fired).toBe(true);
  });

  it('LONG_PRESS_MS is the Facebook-style 500ms hold', () => {
    expect(LONG_PRESS_MS).toBe(500);
    expect(LONG_PRESS_MOVE_PX).toBe(10);
  });

  it('a press released before maturing never fires and swallows nothing', () => {
    const lp = createLongPress();
    lp.begin(0, 0);
    expect(lp.end()).toBe(false);
    expect(lp.fire()).toBe(false); // too late — the press is over
  });

  it('drift past the move threshold cancels the hold (the press became a scroll)', () => {
    const lp = createLongPress();
    lp.begin(50, 50);
    expect(lp.move(55, 54)).toBe(true); // ~6px — still a hold
    expect(lp.move(50, 61)).toBe(false); // 11px — cancelled
    expect(lp.fire()).toBe(false);
    expect(lp.end()).toBe(false);
  });

  it('a custom move threshold is honoured', () => {
    const lp = createLongPress({ moveThreshold: 4 });
    lp.begin(0, 0);
    expect(lp.move(3, 3)).toBe(false); // ~4.2px > 4
  });

  it('a matured hold reports exactly one swallow at end()', () => {
    const lp = createLongPress();
    lp.begin(10, 10);
    lp.fire();
    expect(lp.end()).toBe(true);  // this press's click must be swallowed
    expect(lp.end()).toBe(false); // …and only that one
  });

  it('cancel() before maturing kills the hold but never a latched fire', () => {
    const early = createLongPress();
    early.begin(0, 0);
    early.cancel();
    expect(early.fire()).toBe(false);
    expect(early.end()).toBe(false);

    const late = createLongPress();
    late.begin(0, 0);
    late.fire();
    late.cancel(); // a scroll starting after the popup opened…
    expect(late.end()).toBe(true); // …must not un-swallow the release click
  });

  it('begin() re-arms cleanly after a fired hold', () => {
    const lp = createLongPress();
    lp.begin(0, 0); lp.fire(); lp.end();
    lp.begin(5, 5);
    expect(lp.fired).toBe(false);
    expect(lp.tracking).toBe(true);
    expect(lp.end()).toBe(false);
  });
});

describe('main.js wiring — popup element, hold, swallow, dismissal', () => {
  it('builds ONE popup element in document.body, outside #app', () => {
    expect(mainSrc).toContain("reactionPopupEl.id = 'reaction-popup'");
    expect(mainSrc).toContain('document.body.appendChild(reactionPopupEl)');
  });

  it('arms the hold from pointer/mouse/touch presses on the Like button only', () => {
    expect(mainSrc).toContain("e.target?.closest?.('[data-act=\"like\"]')");
    expect(mainSrc).toContain("beginLikePress('pointer')");
    expect(mainSrc).toContain("beginLikePress('mouse')");
    expect(mainSrc).toContain("beginLikePress('touch')");
    expect(mainSrc).toContain('LONG_PRESS_MS');
  });

  it('opens the popup from the hold timer with the pressed post id', () => {
    expect(mainSrc).toContain('likeLongPress.fire()');
    expect(mainSrc).toContain('openReactionPopup(likePressAnchor.btn, likePressAnchor.postId)');
  });

  it('swallows exactly the release-click of a matured hold, in capture phase', () => {
    expect(mainSrc).toContain('if (likeLongPress.end()) swallowLikeClick = true;');
    const swallow = mainSrc.match(/window\.addEventListener\('click', \(e\) => \{[^}]*swallowLikeClick[^}]*\}, true\)/s)?.[0] || '';
    expect(swallow).toContain('e.stopPropagation()');
    expect(swallow).toContain('swallowLikeClick = false;');
  });

  it('a fresh press retires a stale swallow flag — but a trailing compat-mouse tail does not', () => {
    // Compatibility mouse events land a few ms after a touch press
    // ends; treating them as a fresh press would retire the swallow
    // flag (and dismiss the popup) before the hold's own click arrives.
    expect(mainSrc).toContain('Date.now() - likePressEndedAt < 120');
    expect(mainSrc).toContain('if (!trailing) {\n    swallowLikeClick = false;');
  });

  it('the react case resolves the popup post id and closes the popup', () => {
    expect(mainSrc).toContain('const pid = postId || reactionPopupPostId;');
    expect(mainSrc).toContain('api.toggleReaction(pid, actEl.dataset.emoji)');
  });

  it('dismisses on outside press, Escape, scroll and route change', () => {
    expect(mainSrc).toContain("!e.target?.closest?.('#reaction-popup')) closeReactionPopup();");
    expect(mainSrc).toContain("if (e.key === 'Escape') closeReactionPopup();");
    expect(mainSrc).toContain('if (reactionPopupPostId) closeReactionPopup();');
    expect(mainSrc).toMatch(/hashchange[^\n]*closeReactionPopup\(\)/);
  });

  it('highlights the viewer’s current reaction when the popup opens', () => {
    expect(mainSrc).toContain("reactionButtonsHtml(post?.reactions?.[me()?.id] || '')");
  });

  it('keeps the browser context menu off the Like button', () => {
    expect(mainSrc).toContain("e.target?.closest?.('[data-act=\"like\"]')) e.preventDefault();");
  });
});

describe('styles — the row is gone, the popup is styled', () => {
  it('no longer styles an in-card reaction bar or its desktop hover reveal', () => {
    expect(css).not.toContain('.reaction-bar');
    expect(css).not.toContain('.post-actions:hover .reaction-bar');
  });

  it('styles the floating popup as a fixed pill above the content', () => {
    const rule = css.match(/\.reaction-popup \{[^}]*\}/)?.[0] || '';
    expect(rule).toContain('position: fixed');
    expect(rule).toContain('border-radius: var(--radius-pill)');
  });

  it('keeps the shared .reaction-btn hit-area rules (chat picker uses them too)', () => {
    const rule = css.match(/\.reaction-btn \{[^}]*\}/)?.[0] || '';
    expect(rule).toContain('min-width: 36px');
    expect(rule).toContain('min-height: 36px');
  });
});
