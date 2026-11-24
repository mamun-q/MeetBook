// Press gate (2026-11-25) — Like/Comment taps eaten by realtime renders.
//
// Owner report (Firefox for Android): the post Like and Comment buttons
// "have a problem" — taps intermittently do nothing, while desktop
// reproduction passed completely. Root mechanism (proven with the real
// app at 390px in Chromium + Firefox): render() rebuilds #app
// wholesale on every data event, and realtime echoes arrive roughly
// every few seconds on the live site. A press/release pair that
// straddles a rebuild loses its click ENTIRELY — when the pressed node
// is detached before release, both engines drop the click (mouse
// pipeline: 3/3 lost in each; Chromium's touch pipeline retargets and
// survives, Gecko's does not get that chance on the press target).
// The codebase already lost the composer Send button to a mid-press
// rebuild once (composer-send-blur, 2026-11); this generalises the
// protection to every control.
//
// The fix: main.js tracks presses with utils.createPressGate and
// softRender() defers while a press is in flight, flushing on release
// (backstop: PRESS_RENDER_BACKSTOP_MS). The gate's decisions are pure
// and pinned behaviourally here; main.js is never imported in this
// harness (no DOM event loop), so its wiring is pinned at source
// level, in the style of thread-scroll / composer-send-blur.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPressGate, PRESS_RENDER_BACKSTOP_MS } from '../src/utils.js';

const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

describe('createPressGate — the defer/flush decisions', () => {
  it('renders are never deferred while no press is in flight', () => {
    const gate = createPressGate();
    expect(gate.deferRender()).toBe(false);
    expect(gate.pending).toBe(false);
  });

  it('a render arriving mid-press is deferred, then flushed exactly once on release', () => {
    const gate = createPressGate();
    gate.press();
    expect(gate.deferRender()).toBe(true);
    expect(gate.deferRender()).toBe(true); // a burst of echoes still means ONE flush
    expect(gate.release()).toBe(true);
    expect(gate.pending).toBe(false);
    expect(gate.release()).toBe(false); // no second flush
  });

  it('a press with no render during it releases without flushing', () => {
    const gate = createPressGate();
    gate.press();
    expect(gate.release()).toBe(false);
  });

  it('a press starting after a deferred render was flushed behaves normally', () => {
    const gate = createPressGate();
    gate.press(); gate.deferRender(); gate.release();
    expect(gate.deferRender()).toBe(false);
    gate.press();
    expect(gate.deferRender()).toBe(true);
    expect(gate.release()).toBe(true);
  });

  it('one tap, three sources: the flush waits for every source to release', () => {
    // A touch tap surfaces as touch + pointer + compatibility mouse;
    // the press is in flight until the LAST source releases, and an
    // engine that delivers only some sources still engages the gate.
    const gate = createPressGate();
    gate.press('touch'); gate.press('pointer'); gate.press('mouse');
    expect(gate.deferRender()).toBe(true);
    expect(gate.release('pointer')).toBe(false);
    expect(gate.release('touch')).toBe(false);
    expect(gate.active).toBe(true);
    expect(gate.release('mouse')).toBe(true);
    expect(gate.active).toBe(false);
  });

  it('an engine delivering only mouse events still gets the protection', () => {
    const gate = createPressGate();
    gate.press('mouse');
    expect(gate.deferRender()).toBe(true);
    expect(gate.release('mouse')).toBe(true);
  });

  it('a stray release never invents a flush or wedges the gate', () => {
    const gate = createPressGate();
    expect(gate.release('pointer')).toBe(false);
    expect(gate.active).toBe(false);
    gate.press();
    expect(gate.deferRender()).toBe(true);
    expect(gate.release()).toBe(true);
  });

  it('forceFlush (the backstop) reports the waiting render and resets the gate', () => {
    const gate = createPressGate();
    gate.press('touch'); gate.press('pointer');
    gate.deferRender();
    expect(gate.forceFlush()).toBe(true);
    expect(gate.active).toBe(false);
    expect(gate.pending).toBe(false);
    expect(gate.deferRender()).toBe(false);
    expect(gate.forceFlush()).toBe(false);
  });

  it('the backstop is long enough for a deliberate phone tap, short enough to never starve renders', () => {
    expect(PRESS_RENDER_BACKSTOP_MS).toBeGreaterThanOrEqual(800);
    expect(PRESS_RENDER_BACKSTOP_MS).toBeLessThanOrEqual(3000);
  });
});

describe('main.js wiring — the gate actually guards softRender', () => {
  it('tracks presses on the window in the capture phase (no control opts in)', () => {
    expect(mainSrc).toContain("window.addEventListener('pointerdown', startPress('pointer'), true)");
    expect(mainSrc).toContain("window.addEventListener('pointerup', endPress('pointer'), true)");
    expect(mainSrc).toContain("window.addEventListener('pointercancel', endPress('pointer'), true)");
  });

  it('mouse and touch presses are tracked as fallbacks for partial input pipelines', () => {
    expect(mainSrc).toContain("window.addEventListener('mousedown', startPress('mouse'), true)");
    expect(mainSrc).toContain("window.addEventListener('mouseup', endPress('mouse'), true)");
    expect(mainSrc).toContain("window.addEventListener('touchstart', startPress('touch')");
    expect(mainSrc).toContain("window.addEventListener('touchend', endPress('touch'), true)");
  });

  it('softRender consults the gate before any rebuild', () => {
    const soft = mainSrc.slice(mainSrc.indexOf('function softRender()'));
    expect(soft.slice(0, 400)).toContain('pressGate.deferRender()');
  });

  it('release flushes through a 0ms timer (after the click), the backstop through softRender directly', () => {
    expect(mainSrc).toContain('if (flush) setTimeout(() => softRender(), 0);');
    expect(mainSrc).toContain('if (pressGate.forceFlush()) softRender();');
    expect(mainSrc).toContain('PRESS_RENDER_BACKSTOP_MS');
  });

  it('the pre-existing softRender guards are untouched (voice recording, typing focus)', () => {
    const soft = mainSrc.slice(mainSrc.indexOf('function softRender()'), mainSrc.indexOf('function softRender()') + 900);
    expect(soft).toContain('if (voiceRec) return;');
    expect(soft).toContain("['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)");
  });
});

describe('focus-comment — the Comment button must visibly land on the comment box', () => {
  it('scrolls an off-screen comment box into view before focusing it', () => {
    const block = mainSrc.slice(mainSrc.indexOf("case 'focus-comment'"), mainSrc.indexOf("case 'focus-comment'") + 700);
    expect(block).toContain("querySelector('.comment-form input')");
    expect(block).toContain('scrollIntoView');
    expect(block).toContain('getBoundingClientRect');
    expect(block).toContain('focus({ preventScroll: true })');
  });
});
