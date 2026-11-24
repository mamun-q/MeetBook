import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Mobile Light Pack (2026-11-24): Limon's phone verdict on the
// Design + Button packs was "ভারি ভারি লাগছে" (feels HEAVY). The
// premium look stays; its rendering cost drops on ≤820px screens:
// solid top/bottom bars (no per-scroll-frame backdrop re-blur),
// single-layer shadow tokens, content-visibility on repeating list
// cards, and calmed decorative loops. Desktop must be untouched —
// every lightening rule lives inside ONE @media (max-width: 820px)
// block at the end of the stylesheet, so these pins slice that
// block out and assert inside it (and assert the desktop rules
// before it are unchanged).
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const components = readFileSync(new URL('../src/components.js', import.meta.url), 'utf8');
const lightStart = css.indexOf('Mobile Light Pack');
const light = lightStart >= 0 ? css.slice(lightStart) : '';
const desktop = lightStart >= 0 ? css.slice(0, lightStart) : css;
const ruleIn = (text, re) => text.match(re)?.[0] || '';

describe('mobile light pack — block placement', () => {
  it('exists and is scoped to @media (max-width: 820px)', () => {
    expect(lightStart).toBeGreaterThan(0);
    expect(light).toContain('@media (max-width: 820px)');
  });

  it('desktop chrome keeps its blur (lightening is mobile-only)', () => {
    const topbar = ruleIn(desktop, /\.topbar \{[^}]*\}/);
    expect(topbar).toContain('blur(var(--glass-blur))');
    const nav = (desktop.match(/\.bottom-nav \{[^}]*\}/g) || []).find((r) => r.includes('position: fixed')) || '';
    expect(nav).toContain('blur(var(--glass-blur))');
    // desktop shadow tokens keep their layered values
    expect(desktop).toContain('--shadow: 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.05), 0 6px 16px rgba(16,24,40,.03);');
  });
});

describe('mobile light pack — solid bars, no re-blur while scrolling', () => {
  it('topbar and bottom-nav drop backdrop-filter and go solid on mobile', () => {
    const topbar = ruleIn(light, /\.topbar \{[^}]*\}/);
    expect(topbar).toContain('backdrop-filter: none');
    expect(topbar).toContain('background: var(--header-bg)');
    const nav = ruleIn(light, /\.bottom-nav \{[^}]*\}/);
    expect(nav).toContain('backdrop-filter: none');
    expect(nav).toContain('background: var(--header-bg)');
  });

  it('header background token goes fully opaque on mobile, light + dark', () => {
    expect(light).toContain('--header-bg: #ffffff;');
    expect(light).toContain('--header-bg: #13151a;');
    const dark = ruleIn(light, /html\[data-theme="dark"\] \{[^}]*\}/);
    expect(dark).toContain('--header-bg: #13151a');
  });
});

describe('mobile light pack — single-layer shadows on mobile', () => {
  it('core shadow tokens collapse to one soft layer (lg keeps at most two)', () => {
    expect(light).toContain('--shadow: 0 1px 3px rgba(16,24,40,.07);');
    expect(light).toContain('--shadow-md: 0 2px 8px rgba(16,24,40,.09);');
    expect(light).toContain('--shadow-lg: 0 8px 24px rgba(16,24,40,.13), 0 2px 6px rgba(16,24,40,.07);');
  });

  it('button shadows collapse to single layers; primary keeps ONE coloured layer', () => {
    expect(light).toContain('--btn-shadow: 0 1px 3px rgba(16,24,40,.08);');
    expect(light).toContain('--btn-shadow-primary: 0 2px 8px rgba(var(--brand-rgb),.30);');
    expect(light).toContain('--btn-shadow-danger: 0 2px 8px rgba(229,72,77,.26);');
    expect(light).toContain('--icon-btn-shadow: 0 1px 2px rgba(16,24,40,.07);');
    // the multi-layer desktop primary shadow must NOT reappear in the mobile block
    expect(light).not.toContain('0 4px 14px rgba(var(--brand-rgb)');
  });

  it('dark theme re-declares the lightened tokens (parity, no dark-only colours)', () => {
    const dark = ruleIn(light, /html\[data-theme="dark"\] \{[^}]*\}/);
    expect(dark).toContain('--shadow: 0 1px 3px rgba(0,0,0,.4);');
    expect(dark).toContain('--btn-shadow-primary: 0 2px 8px rgba(var(--brand-rgb),.32);');
    expect(dark).toContain('--icon-btn-shadow: 0 1px 2px rgba(0,0,0,.35);');
  });
});

describe('mobile light pack — content-visibility on repeating cards', () => {
  it('feed posts, discovery cards and conversation rows skip off-screen rendering', () => {
    const post = ruleIn(light, /\.post-card \{[^}]*\}/);
    expect(post).toContain('content-visibility: auto');
    expect(post).toContain('contain-intrinsic-size: auto 480px');
    const person = ruleIn(light, /\.person-card, \.event-card \{[^}]*\}/);
    expect(person).toContain('content-visibility: auto');
    const conv = ruleIn(light, /\.conv-item \{[^}]*\}/);
    expect(conv).toContain('content-visibility: auto');
    expect(conv).toContain('contain-intrinsic-size: auto 64px');
  });

  it('chat message rows are deliberately excluded (thread scroll anchoring)', () => {
    // no .msg-row RULE in the block (the word appears only in comments)
    expect(light).not.toMatch(/\.msg-row\s*\{/);
    expect(light).not.toMatch(/\.msg-row\s*,/);
  });
});

describe('mobile light pack — calmed decorative loops', () => {
  it('boot shine stops and the skeleton pulse slows on mobile', () => {
    const shine = ruleIn(light, /\.boot-logo::after \{[^}]*\}/);
    expect(shine).toContain('animation: none');
    const skel = ruleIn(light, /\.skel \{[^}]*\}/);
    expect(skel).toContain('animation-duration: 2.2s');
  });

  it('reduced-motion still neutralises the loops globally', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation-iteration-count: 1 !important');
  });
});

describe('mobile light pack — feed image widths already phone-sane', () => {
  it('feed post images request 1080w (not full-size originals)', () => {
    expect(components).toContain('cldImg(post.image, 1080)');
  });
});
