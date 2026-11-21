// @vitest-environment jsdom
// Audit fix #3 — DOM-level regression for the login error path, with
// the REAL src/main.js + src/api.js (the @supabase/supabase-js package
// is stubbed so api runs its LIVE login code:
// signInWithPassword -> friendlySupabaseAuthError). The audit found
// wrong-password logins failing silently. Code-level diagnosis showed
// the error toast IS raised — the proven defect in this area is on
// the success path: the login branch raises its toast and THEN sets
// location.hash, and the hashchange handler's clearToasts() wiped the
// toast in the same tick, so auth feedback never survived the
// navigation it caused. Both paths are pinned here end to end.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const hoisted = vi.hoisted(() => ({ authCb: null }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async ({ email, password }) => {
        if (password === 'wrong-pass') {
          return { data: { user: null, session: null }, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } };
        }
        const user = { id: 'u_human', email, app_metadata: { provider: 'email' }, user_metadata: {} };
        const session = { user, access_token: 'stub-token' };
        queueMicrotask(() => { if (hoisted.authCb) hoisted.authCb('SIGNED_IN', session); });
        return { data: { user, session }, error: null };
      },
      signUp: vi.fn(async () => ({ data: { user: null, session: null }, error: { message: 'unused in this test' } })),
      signInWithOAuth: vi.fn(async () => ({ data: {}, error: { message: 'unused in this test' } })),
      resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
      signOut: vi.fn(async () => { if (hoisted.authCb) hoisted.authCb('SIGNED_OUT', null); return { error: null }; }),
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: (cb) => {
        hoisted.authCb = cb;
        queueMicrotask(() => cb('INITIAL_SESSION', null));
        return { data: { subscription: { unsubscribe: () => {} } } };
      }
    },
    // PostgREST surface: only the chains ensureAuthProfile walks are
    // fully shaped (select -> eq -> maybeSingle); every sync fetcher's
    // chain dead-ends into its own try/catch, exactly like a failed
    // read would — the mirror simply stays empty for this test.
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        maybeSingle: async () => ({ data: null, error: null })
      }),
      update: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }),
      insert: () => ({ select: async () => ({ data: [], error: null }) }),
      upsert: () => ({ select: async () => ({ data: [], error: null }) }),
      delete: () => ({ eq: async () => ({ data: null, error: null }) })
    }),
    channel: () => ({
      on() { return this; },
      subscribe() { return this; },
      track: async () => 'ok',
      presenceState: () => ({})
    }),
    removeChannel: async () => 'ok',
    rpc: async () => ({ data: null, error: null })
  })
}));

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 10)); };
const toastText = () => document.getElementById('toast-root')?.textContent || '';

function submitLogin(password) {
  const form = document.querySelector('#login-form');
  expect(form, 'login form is rendered').toBeTruthy();
  form.querySelector('input[name="email"]').value = 'hasan@example.com';
  form.querySelector('input[name="password"]').value = password;
  if (form.requestSubmit) form.requestSubmit();
  else form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="toast-root"></div>';
  window.location.hash = '#/login';
  await import('../src/main.js');
  await settle();
});

describe('login feedback (audit #3)', () => {
  it('a wrong password shows the friendly error toast', async () => {
    document.getElementById('toast-root').innerHTML = '';
    submitLogin('wrong-pass');
    await settle();
    expect(toastText()).toContain('Wrong email or password.');
  });

  it('a successful login keeps its "Welcome back!" toast through the navigation it triggers', async () => {
    document.getElementById('toast-root').innerHTML = '';
    submitLogin('correct-pass');
    await settle();
    expect(window.location.hash).toBe('#/'); // the navigation really happened
    expect(toastText()).toContain('Welcome back!'); // …and the toast survived it
  });
});
