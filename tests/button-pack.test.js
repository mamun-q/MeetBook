import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Premium Button Pack (2026-11-24): Limon's verdict on the Full
// Design Pack was "our buttons are not premium" — only primary/danger
// were glossy while the buttons users touch most (default .btn,
// .btn-ghost, inactive tabs, action bar, header icon buttons) were
// flat dull grey. This pack puts EVERY button family on one pill
// system resolved through button tokens: filled = gradient + lit
// edge + coloured shadow that collapses on press, default = brand
// tint, ghost/google = bordered surface + soft shadow, tabs =
// segmented pill track, icon buttons = surface circles, bottom-nav
// active = tinted pill. CSS-only: these pins guard the system.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const rule = (re) => css.match(re)?.[0] || '';

describe('button pack — tokens', () => {
  it('defines the button tokens single-sourced, with dark parity', () => {
    expect(css).toContain('--radius-pill: 999px');
    expect(css).toContain('--btn-tint: rgba(var(--brand-rgb),.08)');
    expect(css).toContain('--btn-tint-border: rgba(var(--brand-rgb),.22)');
    expect(css).toContain('--btn-shadow-primary-press');
    expect(css).toContain('--icon-btn-shadow');
    expect(css).toContain('--tab-track: var(--surface-2)');
    // dark theme re-declares the same token names (no dark-only colours)
    expect(css.match(/--btn-tint:/g)?.length).toBe(2);
    expect(css.match(/--btn-tint-hover:/g)?.length).toBe(2);
    expect(css).toContain('--btn-tint: rgba(var(--brand-rgb),.16)');
  });
});

describe('button pack — core families', () => {
  it('default .btn is a brand-tinted pill, never flat surface-2 grey', () => {
    const btn = rule(/\.btn \{[^}]*\}/);
    expect(btn).toContain('border-radius: var(--radius-pill)');
    expect(btn).toContain('min-height: 48px');
    expect(btn).toContain('font-weight: 700');
    expect(btn).toContain('background: var(--btn-tint)');
    expect(btn).toContain('color: var(--brand-dark)');
    expect(btn).toContain('box-shadow: var(--btn-shadow)');
    expect(btn).not.toContain('background: var(--surface-2)');
    expect(btn).toContain('transition: transform .18s');
  });

  it('.btn-sm shares the pill radius and a 40px target (no one-off 10px)', () => {
    const sm = rule(/\.btn-sm \{[^}]*\}/);
    expect(sm).toContain('border-radius: var(--radius-pill)');
    expect(sm).toContain('min-height: 40px');
    expect(sm).not.toContain('10px');
  });

  it('filled buttons keep the gradient and collapse their shadow on press', () => {
    const primary = rule(/\.btn-primary \{[^}]*\}/);
    expect(primary).toContain('background: var(--grad)');
    expect(primary).toContain('box-shadow: var(--btn-shadow-primary)');
    const press = rule(/\.btn-primary:active \{[^}]*\}/);
    expect(press).toContain('box-shadow: var(--btn-shadow-primary-press)');
    const dangerPress = rule(/\.btn-danger:active \{[^}]*\}/);
    expect(dangerPress).toContain('box-shadow: var(--btn-shadow-danger-press)');
    const anyBtn = rule(/\.btn:active \{[^}]*\}/);
    expect(anyBtn).toContain('transform: scale(.97)');
  });

  it('ghost is a bordered surface with a real shadow, not flat', () => {
    const ghost = rule(/\.btn-ghost \{[^}]*\}/);
    expect(ghost).toContain('background: var(--surface)');
    expect(ghost).toContain('border-color: var(--border)');
    expect(ghost).toContain('box-shadow: var(--btn-shadow)');
    expect(ghost).not.toContain('--btn-shadow-flat');
  });

  it('Google button stays a recognisable white bordered button, premium shadow', () => {
    const google = rule(/\.btn-google \{[^}]*\}/);
    expect(google).toContain('background: var(--surface)');
    expect(google).toContain('border-color: var(--border)');
    expect(google).toContain('box-shadow: var(--btn-shadow)');
    expect(google).not.toContain('var(--grad)');
  });

  it('disabled state stays desaturated and shadowless', () => {
    const dis = rule(/\.btn:disabled \{[^}]*\}/);
    expect(dis).toContain('saturate(.55)');
    expect(dis).toContain('box-shadow: none !important');
  });
});

describe('button pack — tabs, chips, icon buttons, action bar, bottom nav', () => {
  it('tabs are a segmented pill track with a gradient active pill', () => {
    const tabs = rule(/\.tabs \{[^}]*\}/);
    expect(tabs).toContain('background: var(--tab-track)');
    expect(tabs).toContain('border-radius: var(--radius-pill)');
    expect(tabs).toContain('padding: 4px');
    const tab = rule(/\.tab \{[^}]*\}/);
    expect(tab).toContain('background: transparent');
    expect(tab).toContain('border-radius: var(--radius-pill)');
    expect(tab).toContain('min-height: 44px');
    const active = rule(/\.tab\.active \{[^}]*\}/);
    expect(active).toContain('background: var(--grad)');
    expect(active).toContain('box-shadow: var(--btn-shadow-primary)');
  });

  it('reaction chips are tinted pills; mine is a gradient pill with shadow', () => {
    const chip = rule(/\.msg-chip \{[^}]*\}/);
    expect(chip).toContain('background: var(--btn-tint)');
    expect(chip).toContain('border-radius: var(--radius-pill)');
    const mine = rule(/\.msg-chip\.mine \{[^}]*\}/);
    expect(mine).toContain('background: var(--grad)');
    expect(mine).toContain('box-shadow: var(--btn-shadow-primary)');
  });

  it('icon buttons are surface circles with a soft shadow, press scale .92', () => {
    const iconBtn = rule(/\.icon-btn \{[^}]*\}/);
    expect(iconBtn).toContain('background: var(--surface)');
    expect(iconBtn).toContain('box-shadow: var(--icon-btn-shadow)');
    expect(iconBtn).toContain('border-radius: 50%');
    const press = rule(/\.icon-btn:active \{[^}]*\}/);
    expect(press).toContain('transform: scale(.92)');
  });

  it('action bar tints on hover/press but never turns gradient', () => {
    const action = rule(/\.action-btn \{[^}]*\}/);
    expect(action).toContain('border-radius: var(--radius-pill)');
    expect(action).not.toContain('var(--grad)');
    const hover = rule(/\.action-btn:hover \{[^}]*\}/);
    expect(hover).toContain('background: var(--btn-tint)');
    const active = rule(/\.action-btn\.active \{[^}]*\}/);
    expect(active).toContain('box-shadow: inset 0 0 0 1px rgba(229,72,77,.18)');
  });

  it('conversation filter chips wrap inside the list pane (no clipped Requests chip, no h-scrollbar)', () => {
    // Two consecutive live sweeps (design pack 0f236ef AND button pack
    // 92a16a4) found the same defect: the All / Unread / Archived /
    // Requests row is wider than the 300px conversation pane, so
    // "Requests (2)" clipped and .conv-list grew a horizontal
    // scrollbar. The row must wrap and its pills must shrink.
    const filters = rule(/\.conv-filters \{[^}]*\}/);
    expect(filters).toContain('flex-wrap: wrap');
    expect(filters).toContain('max-width: 100%');
    expect(filters).toContain('box-sizing: border-box');
    const chip = rule(/\.conv-filters \.btn \{[^}]*\}/);
    expect(chip).toContain('flex: 1 1 40%');
    expect(chip).toContain('min-width: 0');
    expect(chip).toContain('padding-left: .5rem');
    expect(chip).toContain('padding-right: .5rem');
    expect(chip).toContain('white-space: nowrap');
    // the pane itself must never grow a horizontal scrollbar from a
    // stray wide row, while vertical scrolling stays
    const list = rule(/\.conv-list \{[^}]*\}/);
    expect(list).toContain('overflow-y: auto');
    expect(list).toContain('overflow-x: hidden');
  });

  it('bottom-nav active item gets a tinted pill behind the icon (old 3px bar gone)', () => {
    const pill = rule(/\.bottom-nav-item\.active::before \{[^}]*\}/);
    expect(pill).toContain('background: var(--btn-tint)');
    expect(pill).toContain('border-radius: var(--radius-pill)');
    expect(pill).not.toContain('height: 3px');
    // shell clearance + safe-area rules the indicator must not break
    expect(css).toContain('padding-bottom: calc(84px + env(safe-area-inset-bottom, 0px))');
    expect(css).toContain('.bottom-nav-label { font-size: .68rem; font-weight: 600; }');
  });
});
