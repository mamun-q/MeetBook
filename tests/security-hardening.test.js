// Security hardening regression tests (2026-11-22 pass).
//
// Live probe evidence behind these tests: a normal signed-in user can
// insert rows via Supabase REST with CRAFTED ids (RLS pins authorship,
// not id format) — e.g. a post whose id is `p1" onmouseover="alert(1)`
// round-tripped verbatim. Every id-family interpolation in the HTML
// templates (src/views.js, src/components.js) is now escapeHtml-wrapped,
// so a crafted id renders as inert text inside the attribute instead of
// breaking out of it. These tests pin that behaviour.
import { describe, it, expect } from 'vitest';
import { postCardHtml, linkify, avatarHtml } from '../src/components.js';
import { safeMediaUrl, safeCssImageUrl } from '../src/utils.js';

const meUser = { id: 'me', name: 'Me', username: 'me' };
const author = { id: 'a1', name: 'Asha', username: 'asha' };
const ctx = { me: meUser, usersById: { me: meUser, a1: author }, d: { groups: [], pages: [] } };
const basePost = {
  id: 'p1', authorId: 'a1', text: 'hi', image: '', visibility: 'public',
  likes: [], reactions: {}, comments: [], shares: 0, savedBy: [], createdAt: Date.now()
};

describe('crafted document ids cannot break out of HTML attributes', () => {
  it('escapes a post id carrying an event-handler payload', () => {
    const evil = 'p1" onmouseover="alert(1)';
    const html = postCardHtml({ ...basePost, id: evil }, ctx);
    expect(html).not.toContain('" onmouseover="alert(1)"');
    expect(html).not.toContain('onmouseover="alert');
    expect(html).toContain('data-post="p1&quot; onmouseover=&quot;alert(1)"');
    expect(html).toContain('id="menu-p1&quot; onmouseover=&quot;alert(1)"');
  });

  it('escapes a crafted poll option id', () => {
    const post = {
      ...basePost,
      poll: { options: [{ id: 'o1" autofocus="alert(1)', text: 'x' }], votes: {} }
    };
    const html = postCardHtml(post, ctx);
    expect(html).not.toContain('autofocus="alert(1)"');
    expect(html).toContain('data-option="o1&quot; autofocus=&quot;alert(1)"');
  });

  it('escapes a crafted comment id', () => {
    const post = {
      ...basePost,
      comments: [{ id: 'c1" onclick="alert(1)', authorId: 'a1', text: 'hey', createdAt: Date.now(), replies: [] }]
    };
    const html = postCardHtml(post, ctx);
    expect(html).not.toContain('onclick="alert(1)"');
    expect(html).toContain('data-comment="c1&quot; onclick=&quot;alert(1)"');
  });

  it('leaves ordinary app-generated ids byte-identical', () => {
    const html = postCardHtml({ ...basePost, id: 'p_mwrxu7q3_dxl' }, ctx);
    expect(html).toContain('data-post="p_mwrxu7q3_dxl"');
    expect(html).toContain('id="menu-p_mwrxu7q3_dxl"');
  });
});

describe('media URL scheme allowlist', () => {
  it('passes http(s) and data: URLs, collapses everything else', () => {
    expect(safeMediaUrl('https://res.cloudinary.com/x.jpg')).toBe('https://res.cloudinary.com/x.jpg');
    expect(safeMediaUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
    expect(safeMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeMediaUrl('javascript:alert(1)')).toBe('#');
    expect(safeMediaUrl('JaVaScRiPt:alert(1)')).toBe('#');
    expect(safeMediaUrl('vbscript:msgbox')).toBe('#');
    expect(safeMediaUrl('')).toBe('#');
    expect(safeMediaUrl(null)).toBe('#');
  });

  it('CSS url() context also rejects quote/paren breakouts', () => {
    expect(safeCssImageUrl('https://res.cloudinary.com/cover.jpg')).toBe('https://res.cloudinary.com/cover.jpg');
    expect(safeCssImageUrl("https://x/a');position:fixed;inset:0")).toBe('#');
    expect(safeCssImageUrl('https://x/a b.jpg')).toBe('#');
    expect(safeCssImageUrl('https://x/a(1).jpg')).toBe('#');
    expect(safeCssImageUrl('javascript:alert(1)')).toBe('#');
  });

  it('avatarHtml never emits a javascript: avatar src', () => {
    const html = avatarHtml({ name: 'Evil', username: 'evil', avatar: 'javascript:alert(1)' }, 40);
    expect(html).toContain('src="#"');
    expect(html).not.toContain('javascript:');
  });
});

describe('linkify stays escape-first', () => {
  it('never lets raw markup from post text reach the DOM', () => {
    const html = linkify('<script>alert(1)</script> <img src=x onerror=alert(2)> @asha');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('<span class="mention">@asha</span>');
  });
});
