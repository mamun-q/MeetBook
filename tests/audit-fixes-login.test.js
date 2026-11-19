// @vitest-environment jsdom
// Audit fix #3 — DOM-level regression for the login error path, with
// the REAL src/main.js + src/api.js (the firebase SDK packages are
// stubbed so api runs its LIVE login code: signInWithEmailAndPassword
// -> friendlyAuthError). The audit found wrong-password logins failing
// silently. Code-level diagnosis showed the error toast IS raised —
// the proven defect in this area is on the success path: the login
// branch raises its toast and THEN sets location.hash, and the
// hashchange handler's clearToasts() wiped the toast in the same
// tick, so auth feedback never survived the navigation it caused.
// Both paths are pinned here end to end.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const hoisted = vi.hoisted(() => ({ authCb: null }));
const signIn = vi.fn(async (auth, email, password) => {
  if (password === 'wrong-pass') {
    const err = new Error('Firebase: Error (auth/invalid-credential).');
    err.code = 'auth/invalid-credential';
    throw err;
  }
  const user = { uid: 'u_human', email };
  queueMicrotask(() => { if (hoisted.authCb) hoisted.authCb(user); });
  return { user };
});

vi.mock('firebase/app', () => ({ initializeApp: () => ({}) }));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({}),
  GoogleAuthProvider: class {},
  createUserWithEmailAndPassword: vi.fn(async () => { throw new Error('unused in this test'); }),
  signInWithEmailAndPassword: (a, e, p) => signIn(a, e, p),
  signInWithPopup: vi.fn(async () => { throw new Error('unused in this test'); }),
  sendPasswordResetEmail: vi.fn(async () => {}),
  signOut: vi.fn(async () => { if (hoisted.authCb) hoisted.authCb(null); }),
  deleteUser: vi.fn(async () => {}),
  onAuthStateChanged: (auth, cb) => { hoisted.authCb = cb; queueMicrotask(() => cb(null)); return () => {}; }
}));
vi.mock('firebase/firestore', () => ({
  getFirestore: () => ({}),
  collection: () => ({}), doc: () => ({}),
  setDoc: vi.fn(async () => {}),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
  getDocs: vi.fn(async () => ({ docs: [] })),
  getCountFromServer: vi.fn(async () => ({ data: () => ({ count: 0 }) })),
  addDoc: vi.fn(async () => ({ id: 'new-doc' })),
  updateDoc: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}),
  query: () => ({}), where: () => ({}), orderBy: () => ({}), limit: () => ({}),
  onSnapshot: () => () => {},
  serverTimestamp: () => Date.now(),
  arrayUnion: (v) => v, arrayRemove: (v) => v
}));
vi.mock('firebase/storage', () => ({
  getStorage: () => ({}), ref: () => ({}),
  uploadBytes: vi.fn(async () => ({})), getDownloadURL: vi.fn(async () => '')
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
