// Performance & Lightness Pass (2026-11-24) — Limon's standing direction:
// NO new features; make the EXISTING site lighter for cheap Android phones
// and slow/low internet. This pass is invisible (same site, less weight):
// its one code change swaps a dead preconnect for the live backend origin.
//
// Audit results pinned so they cannot regress silently:
// - cldImg already sends f_auto,q_auto,w_<n>,c_limit (WebP/AVIF + auto
//   quality + width cap) — pinned in the cloudinary tests; unchanged here.
// - Every content <img> (avatar, post photo, story tile, photos thumb,
//   shared media, chat photo) already carries loading="lazy" +
//   decoding="async" — asserted below so a future render change that
//   drops them fails loudly.
// - index.html preconnects: res.cloudinary.com (feed images) and the
//   Supabase origin (first auth/data calls). The firestore.googleapis.com
//   preconnect is GONE — Firebase is no longer the backend, so warming
//   that connection was pure waste on a slow network.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const components = readFileSync(new URL('../src/components.js', import.meta.url), 'utf8');
const views = readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');

describe('lightness pass — preconnects point at live origins only', () => {
  it('preconnects to the Supabase backend origin', () => {
    expect(indexHtml).toContain('<link rel="preconnect" href="https://ouyuijpxhhvtnxnvavza.supabase.co" crossorigin />');
  });

  it('keeps the Cloudinary preconnect (feed images)', () => {
    expect(indexHtml).toContain('<link rel="preconnect" href="https://res.cloudinary.com" crossorigin />');
  });

  it('no longer preconnects to the dead Firestore origin', () => {
    expect(indexHtml).not.toContain('rel="preconnect" href="https://firestore.googleapis.com"');
  });
});

describe('lightness pass — content images stay lazy + async', () => {
  it('post photos and avatars (components.js) are lazy + async', () => {
    expect(components).toContain('class="post-image" src="${escapeHtml(safeMediaUrl(cldImg(post.image, 1080)))}" alt="Post photo" loading="lazy" decoding="async"');
    expect(components).toMatch(/class="avatar"[^>]*loading="lazy" decoding="async"/);
  });

  it('story tiles, photo thumbs, shared media and chat photos (views.js) are lazy + async', () => {
    expect(views).toContain('class="story-tile-img"');
    expect(views).toContain('class="photos-thumb"');
    expect(views).toContain('class="msg-image"');
    const lazyCount = (views.match(/loading="lazy" decoding="async"/g) || []).length;
    expect(lazyCount).toBeGreaterThanOrEqual(4);
  });
});
