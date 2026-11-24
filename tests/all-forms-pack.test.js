import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  groupFormHtml, pageFormHtml, eventFormHtml, storyFormHtml,
  groupChatFormHtml, settingsView, reportFormHtml, supportAppealFormHtml
} from '../src/views.js';

// All-Forms Premium Pack (2026-11-24): Limon approved extending the
// Edit Profile form style (Profile Form Pack, 39045f2) to every other
// user-facing form — "সব ফর্মে একই প্রিমিয়াম সাজ দাও". DESIGN ONLY:
// the pf-form soft-input scope class is added, group/page/event forms
// are regrouped into the same .pf-section/.pf-chip sections, and NO
// field name, type, value binding or handler changed anywhere.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const viewsSrc = readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const pfStart = css.indexOf('Edit Profile form (Fexbo-style sections)');
const pf = pfStart >= 0 ? css.slice(pfStart) : '';

const countIn = (html, re) => (html.match(re) || []).length;
const fieldOnce = (html, name) => {
  expect(countIn(html, new RegExp(`name="${name}"`, 'g')), `field ${name}`).toBe(1);
};

describe('all-forms pack — sectioned forms (group / page / event)', () => {
  it('group form: pf-form + 3 sections (basic/privacy/photos), fields unchanged', () => {
    const html = groupFormHtml({ id: 'g1', name: 'Club', description: 'Desc', privacy: 'private' });
    expect(html).toContain('<form id="group-form" data-id="g1" class="stack pf-form">');
    expect(countIn(html, /class="pf-section"/g)).toBe(3);
    for (const mod of ['basic', 'privacy', 'photos']) expect(html).toContain(`pf-chip pf-chip--${mod}`);
    for (const n of ['name', 'description', 'privacy', 'cover']) fieldOnce(html, n);
    expect(html).toContain('<input name="name" required maxlength="80" value="Club" />');
    expect(html).toContain('<option value="private" selected>');
    expect(html).toContain('<input type="file" name="cover" accept="image/*" />');
  });

  it('page form: pf-form + 2 sections (basic/photos), fields unchanged', () => {
    const html = pageFormHtml({ id: 'p1', name: 'Page', category: 'Food', about: 'About text' });
    expect(html).toContain('<form id="page-form" data-id="p1" class="stack pf-form">');
    expect(countIn(html, /class="pf-section"/g)).toBe(2);
    for (const mod of ['basic', 'photos']) expect(html).toContain(`pf-chip pf-chip--${mod}`);
    for (const n of ['name', 'category', 'about', 'avatar', 'cover']) fieldOnce(html, n);
    expect(html).toContain('<input name="name" required maxlength="80" value="Page" />');
    expect(html).toContain('>About text</textarea>');
  });

  it('event form: pf-form + 4 sections (basic/time/photos/privacy), fields unchanged', () => {
    const html = eventFormHtml();
    expect(html).toContain('<form id="event-form" class="stack pf-form">');
    expect(countIn(html, /class="pf-section"/g)).toBe(4);
    for (const mod of ['edu', 'time', 'photos', 'privacy']) expect(html).toContain(`pf-chip pf-chip--${mod}`);
    for (const n of ['title', 'description', 'dateTime', 'location', 'cover', 'visibility']) fieldOnce(html, n);
    expect(html).toContain('<input name="title" required maxlength="120" />');
    expect(html).toContain('<input name="dateTime" type="datetime-local" required />');
  });
});

describe('all-forms pack — soft-input-only forms', () => {
  it('story form carries pf-form and keeps its radio/field contract', () => {
    const html = storyFormHtml();
    expect(html).toContain('<form id="story-form" class="stack pf-form">');
    for (const n of ['text', 'image', 'visibility']) fieldOnce(html, n);
    // one radio per background swatch (5), all sharing name="bg"
    expect(countIn(html, /type="radio" name="bg"/g)).toBe(5);
  });

  it('group chat form carries pf-form; member checkboxes stay checkboxes', () => {
    const html = groupChatFormHtml({ friendships: [], users: [] }, { id: 'u1' });
    expect(html).toContain('<form id="group-chat-form" class="stack pf-form">');
    fieldOnce(html, 'title');
  });

  it('settings forms carry pf-form; notification checkboxes untouched', () => {
    const me = { id: 'u1', name: 'Test', username: 'test', email: '', settings: {} };
    const html = settingsView({ blocks: [] }, me, { theme: 'light', locale: 'en' });
    expect(html).toContain('<form id="notif-prefs-form" class="stack pf-form">');
    expect(html).toContain('<form id="privacy-prefs-form" class="stack pf-form">');
    expect(html).toContain('<input type="checkbox" name="like"');
    fieldOnce(html, 'defaultPostPrivacy');
  });

  it('report and appeal forms carry pf-form with fields unchanged', () => {
    const report = reportFormHtml('post', 'p1');
    expect(report).toContain('class="stack pf-form"');
    for (const n of ['category', 'reason']) fieldOnce(report, n);
    const appeal = supportAppealFormHtml({ id: 'r1' });
    expect(appeal).toContain('class="stack pf-form"');
    fieldOnce(appeal, 'text');
  });

  it('review form and group rename form carry pf-form (source pins)', () => {
    expect(viewsSrc).toContain('<form id="review-form" data-page="${escapeHtml(page.id)}" class="stack pf-form">');
    expect(viewsSrc).toContain('<form id="group-rename-form" data-conv="${escapeHtml(conv.id)}" class="row gap-sm pf-form">');
  });

  it('composer poll fields are scoped pf-form without touching the composer form itself', () => {
    expect(viewsSrc).toContain('<div id="poll-fields" class="stack hidden pf-form">');
    expect(viewsSrc).toContain('<form id="composer-form" class="stack">');
  });

  it('main.js modal forms (chat poll / nickname / edit message / edit post) carry pf-form', () => {
    for (const id of ['chat-poll-form', 'nickname-form', 'edit-message-form', 'edit-post-form']) {
      expect(mainSrc).toContain(`<form id="${id}"`);
      expect(mainSrc).toMatch(new RegExp(`<form id="${id}"[^>]*class="stack pf-form"`));
    }
  });
});

describe('all-forms pack — CSS safety', () => {
  it('stack gap collapses ONLY on forms that contain sections (:has), flat forms keep spacing', () => {
    expect(pf).toContain('.pf-form:has(> .pf-section) { gap: 0; }');
    expect(pf).not.toMatch(/^\.pf-form \{ gap: 0; \}/m);
  });

  it('adds the privacy and time chip tints used by the new sections', () => {
    expect(pf).toContain('.pf-chip--privacy { --pf-accent:');
    expect(pf).toContain('.pf-chip--time { --pf-accent:');
  });

  it('input selectors still exclude checkboxes and radios (settings toggles, story/review radios)', () => {
    expect(pf).toMatch(/\.pf-form input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/);
  });

  it('excluded forms keep their own styling (auth, search, comment/reply pills)', () => {
    expect(viewsSrc).toContain('<form id="login-form" class="stack">');
    expect(viewsSrc).toContain('<form id="register-form" class="stack">');
    expect(css).toMatch(/\.comment-form input, \.reply-form input \{[^}]*border-radius: 999px/);
    expect(css).toMatch(/\.search-box input \{[^}]*border-radius: 999px/);
  });
});
