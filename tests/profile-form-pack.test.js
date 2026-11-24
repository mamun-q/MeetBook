import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { editProfileHtml } from '../src/views.js';

// Edit Profile Form Pack (2026-11-24): Limon admired Fexbo's Edit
// Profile — titled sections with soft tinted circular icon chips,
// hairline dividers, soft grey rounded inputs. DESIGN ONLY: the form
// was regrouped into sections, but every field keeps its exact name,
// type, maxlength and value binding, and the save handler in main.js
// (FormData by name) is untouched.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const pfStart = css.indexOf('Edit Profile form (Fexbo-style sections)');
const pf = pfStart >= 0 ? css.slice(pfStart) : '';

const user = {
  name: 'Test User', username: 'test.user', nickname: 'Testy', bio: 'Hello there',
  work: 'Dev at Studio', education: 'University of Dhaka', currentCity: 'Dhaka',
  hometown: 'Khulna', relationship: 'Single', dob: '2000-01-02', gender: 'Female',
  website: 'https://example.com', avatar: '', cover: ''
};
const html = editProfileHtml(user);
const count = (re) => (html.match(re) || []).length;

describe('profile form pack — sections and chips', () => {
  it('renders the form with the pf-form scope class', () => {
    expect(html).toContain('<form id="edit-profile-form" class="stack pf-form">');
  });

  it('groups fields into 7 titled sections, each with a tinted icon chip', () => {
    expect(count(/class="pf-section"/g)).toBe(7);
    for (const mod of ['basic', 'photos', 'edu', 'work', 'places', 'personal', 'web']) {
      expect(html).toContain(`pf-chip pf-chip--${mod}`);
    }
    expect(count(/class="pf-head"/g)).toBe(7);
  });

  it('keeps the modal title and the original save/cancel buttons', () => {
    expect(html).toContain('data-close>Cancel</button>');
    expect(html).toContain('<button class="btn btn-primary" type="submit">Save profile</button>');
  });
});

describe('profile form pack — field compatibility (save handler contract)', () => {
  it('every original field name is present exactly once', () => {
    for (const name of ['name', 'username', 'nickname', 'bio', 'work', 'education',
      'currentCity', 'hometown', 'relationship', 'dob', 'gender', 'website', 'avatar', 'cover']) {
      expect(count(new RegExp(`name="${name}"`, 'g')), `field ${name}`).toBe(1);
    }
  });

  it('keeps types, maxlengths and required flags byte-identical', () => {
    expect(html).toContain('<input name="name" required maxlength="60"');
    expect(html).toContain('<input name="username" required maxlength="24"');
    expect(html).toContain('<input name="nickname" maxlength="40"');
    expect(html).toContain('<textarea name="bio" rows="3" maxlength="300">');
    expect(html).toContain('<input name="work" maxlength="100"');
    expect(html).toContain('<input name="education" maxlength="100"');
    expect(html).toContain('<input name="currentCity" maxlength="80"');
    expect(html).toContain('<input name="hometown" maxlength="80"');
    expect(html).toContain('<select name="relationship">');
    expect(html).toContain('<input name="dob" type="date"');
    expect(html).toContain('<select name="gender">');
    expect(html).toContain('<input name="website" type="text" maxlength="200" placeholder="https://example.com"');
    expect(html).toContain('<input type="file" name="avatar" accept="image/*" />');
    expect(html).toContain('<input type="file" name="cover" accept="image/*" />');
  });

  it('keeps value bindings and selected options working', () => {
    expect(html).toContain('value="Test User"');
    expect(html).toContain('value="test.user"');
    expect(html).toContain('>Hello there</textarea>');
    expect(html).toContain('value="University of Dhaka"');
    expect(html).toContain('<option value="Single" selected>Single</option>');
    expect(html).toContain('<option value="Female" selected>');
    expect(html).toContain('value="2000-01-02"');
    expect(html).toContain('value="https://example.com"');
  });
});

describe('profile form pack — scoped CSS', () => {
  it('has a dedicated pf block in the stylesheet', () => {
    expect(pfStart).toBeGreaterThan(0);
  });

  it('section headers use a tinted circular chip and a hairline divider', () => {
    expect(pf).toMatch(/\.pf-chip \{[^}]*border-radius: 50%/);
    expect(pf).toMatch(/\.pf-chip \{[^}]*color-mix\(in srgb, rgb\(var\(--pf-accent\)\) 13%, transparent\)/);
    expect(pf).toMatch(/\.pf-section \{[^}]*border-bottom: 1px solid var\(--border\)/);
    expect(pf).toMatch(/\.pf-head h4 \{[^}]*text-transform: uppercase/);
  });

  it('declares a distinct accent tint per section', () => {
    for (const mod of ['basic', 'photos', 'edu', 'work', 'places', 'personal', 'web']) {
      expect(pf).toContain(`.pf-chip--${mod} { --pf-accent:`);
    }
  });

  it('inputs inside the form are soft grey, rounded and ring-focused', () => {
    expect(pf).toMatch(/\.pf-form input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), \.pf-form select, \.pf-form textarea \{[^}]*background: var\(--surface-2\)/);
    expect(pf).toMatch(/\.pf-form input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), \.pf-form select, \.pf-form textarea \{[^}]*border-radius: 14px/);
    expect(pf).toMatch(/\.pf-form textarea:focus \{ background: var\(--surface\); border-color: var\(--brand\); box-shadow: var\(--ring\); \}/);
  });

  it('adds no backdrop-filter and no box-shadow in the new block (light-pack safe)', () => {
    expect(pf).not.toContain('backdrop-filter');
    expect(pf).not.toMatch(/box-shadow: (?!none|var\(--ring\))/);
  });

  it('every pf rule is scoped under .pf- classes (no global form restyle)', () => {
    const selectors = pf.split('}').flatMap((chunk) => {
      const open = chunk.lastIndexOf('{');
      if (open < 0) return [];
      return chunk.slice(0, open).split('\n').map((s) => s.trim()).filter((s) => s.endsWith(',') || s.includes('.pf'));
    });
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) expect(sel).toContain('.pf');
  });
});
