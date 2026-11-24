import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Full Design Pack (2026-11-24): ONE design system for MeetBook —
// unified tokens (brand colours only via --brand-rgb triplets), one
// radius/spacing scale, light glass (heavy backdrop-blur janks on
// phones, esp. Firefox Android), transform/opacity motion at
// 120–200ms, boot skeleton, auth page on the same tokens as the app.
// CSS-first: these pins guard the unification + the preserved
// constraints from earlier packs.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

describe('design pack — one token set', () => {
  it('defines the unified tokens (rgb triplets, radius + spacing scales, glass)', () => {
    expect(css).toContain('--brand-rgb: 24,119,242');
    expect(css).toContain('--brand-2-rgb: 155,77,255');
    expect(css).toContain('--accent-rgb: 18,183,106');
    expect(css).toContain('--radius-lg: 24px');
    expect(css).toContain('--space-3: 12px');
    expect(css).toContain('--space-4: 16px');
    expect(css).toContain('--glass-blur: 8px');
  });

  it('no hardcoded brand-blue rgba remains outside the token definition', () => {
    const hits = css.match(/rgba\(24,119,242/g) || [];
    expect(hits.length).toBe(0);
    const spaced = css.match(/rgba\(24, 119, 242/g) || [];
    expect(spaced.length).toBe(0);
  });

  it('card + modal + auth card resolve through the shared tokens', () => {
    const card = css.match(/\.card \{[^}]*\}/)?.[0] || '';
    expect(card).toContain('padding: var(--space-4)');
    expect(card).toContain('border-radius: var(--radius)');
    const modal = css.match(/\.modal \{[^}]*\}/)?.[0] || '';
    expect(modal).toContain('border-radius: var(--radius-lg)');
    const auth = css.match(/\.auth-card \{[^}]*\}/)?.[0] || '';
    expect(auth).toContain('border-radius: var(--radius-lg)');
    expect(auth).toContain('background: var(--surface)');
  });

  it('own chat bubbles fall back to the unified gradient (themes still override)', () => {
    const mine = css.match(/\.msg-bubble\.mine \{[^}]*\}/)?.[0] || '';
    expect(mine).toContain('var(--bubble-mine, var(--grad))');
  });
});

describe('design pack — smoothness (light glass, short motion)', () => {
  it('no heavy 14px backdrop blur anywhere', () => {
    expect(css).not.toContain('blur(14px)');
    const topbar = css.match(/\.topbar \{[^}]*\}/)?.[0] || '';
    expect(topbar).toContain('blur(var(--glass-blur))');
    const nav = (css.match(/\.bottom-nav \{[^}]*\}/g) || []).find((r) => r.includes('position: fixed')) || '';
    expect(nav).toContain('blur(var(--glass-blur))');
  });

  it('auth card and toast carry no backdrop-filter (solid surfaces)', () => {
    const auth = css.match(/\.auth-card \{[^}]*\}/)?.[0] || '';
    expect(auth).not.toContain('backdrop-filter');
    const toast = css.match(/\.toast \{[^}]*\}/)?.[0] || '';
    expect(toast).not.toContain('backdrop-filter');
    expect(toast).toContain('transition: opacity .18s ease, transform .18s ease');
  });
});

describe('design pack — boot skeleton', () => {
  it('skeleton styles exist and are opacity-only pulse', () => {
    expect(css).toContain('.boot-skeleton');
    expect(css).toContain('.skel-card');
    expect(css).toContain('@keyframes skel-pulse');
  });

  it('both boot splashes render the skeleton (static index + JS splash)', () => {
    expect(indexHtml).toContain('boot-skeleton');
    expect(mainSrc).toContain('boot-skeleton');
    // the original splash elements are preserved
    expect(mainSrc).toContain('boot-spinner');
    expect(indexHtml).toContain('Loading MeetBook…');
  });
});

describe('design pack — preserved constraints from earlier packs', () => {
  it('profile name-slicing fix, chat shell, reaction targets intact', () => {
    expect(css).toContain('.profile-meta > .avatar');
    expect(css).toContain('body.chat-open { overflow: hidden; }');
    expect(css).toContain('body.chat-open .thread-body { flex: 1; min-height: 0; max-height: none; }');
    const reaction = css.match(/\.reaction-btn \{[^}]*\}/)?.[0] || '';
    expect(reaction).toContain('min-width: 36px');
    expect(reaction).toContain('min-height: 36px');
  });

  it('admin users table keeps its min-width sideways-scroll rule on mobile', () => {
    expect(css).toContain('.table.admin-users-table { min-width: 680px; }');
  });

  it('emoji panel still anchors above the composer', () => {
    const panel = css.match(/\.emoji-panel \{[^}]*\}/)?.[0] || '';
    expect(panel).toContain('bottom: calc(100% + 6px)');
    expect(panel).toContain('z-index: 30');
  });

  it('reduced-motion block still calms animations', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});
