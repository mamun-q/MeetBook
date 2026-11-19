// Super Admin Pack A — roles, enforcement, audit log, user management.
// Pure-helper and view tests run against synthetic data; the audit-log /
// user-action tests run the REAL api.js in demo mode (firebase mocked
// out, localStorage shimmed), mirroring tests/gemini-wiring.test.js.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/firebase.js', () => ({
  firebaseReady: false, isFirebaseConfigured: false, firebaseConfig: {},
  app: null, auth: null, db: null, storage: null, googleProvider: null
}));

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

import {
  isStaff, canModerate, isAdminRole, isSuperAdmin, isAnalyst,
  accountStatus, canManageUser, canChangeRole
} from '../src/utils.js';
import { userNameHtml } from '../src/components.js';
import { setLocale } from '../src/i18n.js';

let V;
let api;
let store;

beforeAll(async () => {
  V = await import('../src/views.js');
  store = await import('../src/store.js');
  api = await import('../src/api.js');
});

const user = (role, extra = {}) => ({ id: `id_${role}_${extra.id || 'x'}`, name: 'Test Person', username: 'test.person', role, isBot: false, ...extra });

describe('role helpers', () => {
  it('classifies the full role ladder', () => {
    expect(isStaff(user('user'))).toBe(false);
    expect(isStaff(user('analyst'))).toBe(true);
    expect(isStaff(user('moderator'))).toBe(true);
    expect(isStaff(user('admin'))).toBe(true);
    expect(isStaff(user('superadmin'))).toBe(true);
    expect(isStaff(user('bot', { isBot: true }))).toBe(false);
    expect(isStaff(null)).toBe(false);
  });

  it('gates moderation and admin tiers', () => {
    expect(canModerate(user('analyst'))).toBe(false);
    expect(canModerate(user('moderator'))).toBe(true);
    expect(canModerate(user('admin'))).toBe(true);
    expect(isAdminRole(user('moderator'))).toBe(false);
    expect(isAdminRole(user('admin'))).toBe(true);
    expect(isAdminRole(user('superadmin'))).toBe(true);
    expect(isSuperAdmin(user('admin'))).toBe(false);
    expect(isSuperAdmin(user('superadmin'))).toBe(true);
    expect(isAnalyst(user('analyst'))).toBe(true);
    expect(isAnalyst(user('admin'))).toBe(false);
  });

  it('accountStatus defaults absent/unknown to active', () => {
    expect(accountStatus({})).toBe('active');
    expect(accountStatus({ status: 'weird' })).toBe('active');
    expect(accountStatus({ status: 'suspended' })).toBe('suspended');
    expect(accountStatus({ status: 'banned' })).toBe('banned');
    expect(accountStatus(null)).toBe('active');
  });

  it('canManageUser protects self, bots and superadmins; analysts/moderators cannot manage', () => {
    const admin = user('admin', { id: 'a1' });
    const target = user('user', { id: 't1' });
    expect(canManageUser(admin, target)).toBe(true);
    expect(canManageUser(user('superadmin', { id: 's1' }), user('admin', { id: 'a2' }))).toBe(true);
    expect(canManageUser(admin, admin)).toBe(false); // self
    expect(canManageUser(admin, user('superadmin', { id: 's2' }))).toBe(false); // superadmin target
    expect(canManageUser(user('superadmin', { id: 's1' }), user('superadmin', { id: 's2' }))).toBe(false);
    expect(canManageUser(admin, user('bot', { id: 'b1', isBot: true }))).toBe(false); // bot
    expect(canManageUser(user('analyst', { id: 'an1' }), target)).toBe(false);
    expect(canManageUser(user('moderator', { id: 'm1' }), target)).toBe(false);
    expect(canManageUser(user('user', { id: 'u1' }), target)).toBe(false);
  });

  it('canChangeRole is superadmin-only and protects own/other-superadmin roles', () => {
    const sup = user('superadmin', { id: 's1' });
    expect(canChangeRole(sup, user('user', { id: 't1' }))).toBe(true);
    expect(canChangeRole(sup, user('admin', { id: 'a1' }))).toBe(true);
    expect(canChangeRole(user('admin', { id: 'a1' }), user('user', { id: 't1' }))).toBe(false);
    expect(canChangeRole(sup, sup)).toBe(false); // own role
    expect(canChangeRole(sup, user('superadmin', { id: 's2' }))).toBe(false); // other superadmin
    expect(canChangeRole(sup, user('bot', { id: 'b1', isBot: true }))).toBe(false);
  });
});

describe('verified badge rendering', () => {
  it('userNameHtml shows the ✓ badge only for verified users', () => {
    expect(userNameHtml({ name: 'A', username: 'a', verified: true })).toContain('badge-verified');
    expect(userNameHtml({ name: 'A', username: 'a' })).not.toContain('badge-verified');
    expect(userNameHtml({ name: 'A', username: 'a', verified: false })).not.toContain('badge-verified');
  });

  it('superadmins get the Admin badge too', () => {
    expect(userNameHtml({ name: 'S', username: 's', role: 'superadmin' })).toContain('badge-admin');
    expect(userNameHtml({ name: 'M', username: 'm', role: 'moderator' })).not.toContain('badge-admin');
  });
});

describe('admin users view', () => {
  const mkUser = (i, extra = {}) => ({
    id: `uu_${i}`, name: `Person ${i}`, username: `person.${i}`, email: `person${i}@x.io`,
    role: 'user', isBot: false, createdAt: 1700000000000 + i * 1000, followers: [], following: [], ...extra
  });
  const data = {
    users: Array.from({ length: 30 }, (_, i) => mkUser(i + 1)),
    posts: [{ id: 'pp1', authorId: 'uu_1' }, { id: 'pp2', authorId: 'uu_1' }, { id: 'pp3', authorId: 'uu_2' }],
    friendships: [{ id: 'ff1', from: 'uu_1', to: 'uu_2', status: 'accepted' }],
    reports: [], bots: [], adminLogs: []
  };
  data.users[4].status = 'suspended'; // uu_5
  data.users[5].verified = true; // uu_6
  const adminViewer = { id: 'boss', name: 'Boss', username: 'boss', role: 'admin', isBot: false };
  const superViewer = { id: 'root', name: 'Root', username: 'root', role: 'superadmin', isBot: false };

  it('paginates 25 per page', () => {
    const page1 = V.adminUsersView(data, adminViewer, {});
    expect(page1.match(/<tr>/g).length).toBe(26); // header + 25 rows
    expect(page1).toContain('Page 1 / 2');
    const page2 = V.adminUsersView(data, adminViewer, { page: 2 });
    expect(page2.match(/<tr>/g).length).toBe(6); // header + 5 rows
    expect(page2).toContain('Page 2 / 2');
  });

  it('renders status + verified badges and computed counts', () => {
    const html = V.adminUsersView(data, adminViewer, {});
    expect(html).toContain('badge-verified'); // uu_6 verified, newest-first so on page 1
    expect(html).toContain('data-act="admin-user-suspend"');
    // uu_5 is the suspended user; newest-first ordering puts it on page 2.
    const page2 = V.adminUsersView(data, adminViewer, { page: 2 });
    expect(page2).toContain('Suspended');
    expect(page2).toContain('data-act="admin-user-unsuspend"');
    expect(page2).not.toContain('data-act="admin-user-suspend" data-id="uu_5"');
  });

  it('filters by search text, status and kind', () => {
    const bySearch = V.adminUsersView(data, adminViewer, { q: 'person 7' });
    expect(bySearch).toContain('Person 7');
    expect(bySearch).not.toContain('Person 8');
    const byStatus = V.adminUsersView(data, adminViewer, { status: 'suspended' });
    expect(byStatus).toContain('Person 5');
    expect(byStatus).not.toContain('Person 6');
    const byKind = V.adminUsersView(data, adminViewer, { kind: 'bots' });
    expect(byKind).toContain('No users match');
  });

  it('role select + delete render only for a superadmin viewer', () => {
    const asAdmin = V.adminUsersView(data, adminViewer, {});
    expect(asAdmin).not.toContain('admin-role-select');
    expect(asAdmin).not.toContain('admin-user-delete');
    const asSuper = V.adminUsersView(data, superViewer, {});
    expect(asSuper).toContain('admin-role-select');
    expect(asSuper).toContain('admin-user-delete');
  });

  it('hides every action for an analyst viewer', () => {
    const analyst = { id: 'an', name: 'Ana', username: 'ana', role: 'analyst', isBot: false };
    const html = V.adminUsersView(data, analyst, {});
    expect(html).not.toContain('admin-user-suspend');
    expect(html).not.toContain('admin-user-verify');
    expect(html).not.toContain('admin-role-select');
  });
});

describe('account status notice view', () => {
  it('renders suspended and banned notices in en and bn', () => {
    setLocale('en');
    expect(V.accountStatusView({ status: 'suspended' })).toContain('Your account has been suspended');
    expect(V.accountStatusView({ status: 'banned' })).toContain('Your account has been banned');
    setLocale('bn');
    expect(V.accountStatusView({ status: 'suspended' })).toContain('আপনার অ্যাকাউন্ট স্থগিত করা হয়েছে');
    setLocale('en');
  });
});

describe('admin security view', () => {
  it('lists audit entries newest-first and filters by action text', () => {
    const d = {
      users: [], posts: [], friendships: [], reports: [], bots: [],
      adminLogs: [
        { id: 'l1', adminId: 'boss', adminName: 'Boss', action: 'suspend-user', targetType: 'user', targetId: 'x', targetLabel: 'Person X', reason: 'spam', createdAt: 1000 },
        { id: 'l2', adminId: 'boss', adminName: 'Boss', action: 'verify-user', targetType: 'user', targetId: 'y', targetLabel: 'Person Y', reason: '', createdAt: 2000 }
      ]
    };
    const viewer = { id: 'boss', name: 'Boss', username: 'boss', role: 'admin', isBot: false };
    const html = V.adminSecurityView(d, viewer, {});
    expect(html.indexOf('verify-user')).toBeLessThan(html.indexOf('suspend-user')); // newest first
    const filtered = V.adminSecurityView(d, viewer, { q: 'suspend' });
    expect(filtered).toContain('suspend-user');
    expect(filtered).not.toContain('verify-user');
  });
});

describe('admin actions + audit log (demo path)', () => {
  it('suspend writes status + a fully-shaped audit entry', async () => {
    await api.login('admin@meetbook.app', 'admin123');
    await api.adminSetUserStatus('u_ayesha', 'suspended', 'Repeated spam reports', 'suspend-user');
    const s = store.getState();
    expect(s.users.find((u) => u.id === 'u_ayesha').status).toBe('suspended');
    const entry = s.adminLogs[0];
    expect(entry).toMatchObject({
      adminId: 'u_admin', adminName: 'MeetBook Admin', action: 'suspend-user',
      targetType: 'user', targetId: 'u_ayesha', targetLabel: 'Ayesha Rahman',
      reason: 'Repeated spam reports'
    });
    expect(typeof entry.createdAt).toBe('number');
    expect(entry.id).toBeTruthy();
  });

  it('refuses self-management and plain-admin role changes', async () => {
    await expect(api.adminSetUserStatus('u_admin', 'suspended', '', 'suspend-user')).rejects.toThrow(/own account/);
    await expect(api.adminSetRole('u_tanvir', 'moderator')).rejects.toThrow(/super admin/i);
    await expect(api.adminDeleteUser('u_tanvir')).rejects.toThrow(/super admin/i);
  });

  it('verify toggles the flag and logs verify-user', async () => {
    await api.adminSetVerified('u_priya', true, 'Public figure');
    const s = store.getState();
    expect(s.users.find((u) => u.id === 'u_priya').verified).toBe(true);
    expect(s.adminLogs[0]).toMatchObject({ action: 'verify-user', targetId: 'u_priya', reason: 'Public figure' });
  });

  it('a superadmin can set roles, but cannot touch another superadmin', async () => {
    store.mutate((s) => { s.users.find((u) => u.id === 'u_admin').role = 'superadmin'; });
    await api.adminSetRole('u_tanvir', 'moderator', 'Community helper');
    let s = store.getState();
    expect(s.users.find((u) => u.id === 'u_tanvir').role).toBe('moderator');
    expect(s.adminLogs[0]).toMatchObject({ action: 'set-role', targetId: 'u_tanvir' });
    store.mutate((st) => { st.users.find((u) => u.id === 'u_priya').role = 'superadmin'; });
    await expect(api.adminSetUserStatus('u_priya', 'banned', '', 'ban-user')).rejects.toThrow(/Super admin/);
    await expect(api.adminSetRole('u_priya', 'user')).rejects.toThrow(/Super admin/);
    s = store.getState();
    expect(s.users.find((u) => u.id === 'u_priya').role).toBe('superadmin');
  });

  it('logAdminAction returns the stored entry shape', async () => {
    const entry = await api.logAdminAction('test-action', { type: 'config', id: 'app', label: 'Test' }, 'because');
    expect(entry).toMatchObject({ action: 'test-action', targetType: 'config', targetId: 'app', targetLabel: 'Test', reason: 'because', adminId: 'u_admin' });
    expect(store.getState().adminLogs[0].action).toBe('test-action');
  });
});
