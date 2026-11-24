// Admin Code-Split Pack (2026-11-24) — under Limon's standing NO-NEW-
// FEATURES direction: behaviour and look are identical; only the download
// split changes. The admin-only views moved from src/views.js into
// src/adminViews.js, which main.js loads lazily via dynamic import() the
// first time an admin route/modal opens. A regular user's initial bundle
// must never contain admin-only code again — these pins fail loudly if
// the split regresses (an admin view sneaks back into views.js, or a
// static import of adminViews appears in main.js/views.js).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as A from '../src/adminViews.js';

const views = readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

export const ADMIN_VIEW_EXPORTS = [
  'roleLabel', 'adminShell', 'adminDeniedView', 'adminOverviewView',
  'adminAnalyticsView', 'adminContentView', 'reportResolveFormHtml',
  'reportsView', 'adminUsersView', 'adminSecurityView', 'botsView',
  'botFormHtml', 'botDetailsView', 'adminAnnounceView', 'adminSettingsView',
  'adminHealthView',
];

describe('admin code split — views.js carries no admin views', () => {
  it('defines none of the admin view functions', () => {
    for (const name of ADMIN_VIEW_EXPORTS) {
      expect(views, `views.js must not define ${name}`).not.toMatch(new RegExp(`(export\\s+)?function ${name}\\b`));
    }
  });

  it('views.js never imports adminViews (dependency is one-way)', () => {
    expect(views).not.toContain('adminViews');
  });

  it('keeps the user-facing report/support functions in views.js', () => {
    expect(views).toMatch(/export function reportFormHtml\b/);
    expect(views).toMatch(/export function supportInboxView\b/);
    expect(views).toMatch(/export function accountStatusView\b/);
  });
});

describe('admin code split — main.js loads adminViews lazily', () => {
  it('uses a dynamic import() for adminViews', () => {
    expect(main).toContain("import('./adminViews.js')");
  });

  it('has no static import of adminViews', () => {
    expect(main).not.toMatch(/import\s+[^;]*from\s+'\.\/adminViews\.js'/);
    expect(main).not.toMatch(/import\s+[^;]*from\s+"\.\/adminViews\.js"/);
  });

  it('adminRoute takes the loaded module instead of reading views', () => {
    expect(main).toContain('function adminRoute(A, d, user, seg, query)');
    expect(main).not.toContain('V.adminShell');
    expect(main).not.toContain('V.botsView');
    expect(main).not.toContain('V.reportsView');
  });
});

describe('admin code split — adminViews exports the full admin surface', () => {
  it('exports every admin view as a function', () => {
    for (const name of ADMIN_VIEW_EXPORTS) {
      expect(typeof A[name], `adminViews.${name}`).toBe('function');
    }
  });
});
