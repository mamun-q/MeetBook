import { describe, it, expect } from 'vitest';
import { t, setLocale, getLocale, availableLocales, LOCALES } from '../src/i18n.js';
import { resolveFirebaseConfig, isConfigComplete, DEFAULT_FIREBASE_CONFIG } from '../src/firebase-config.js';

describe('i18n', () => {
  it('has English and Bangla dictionaries with matching core keys', () => {
    expect(availableLocales()).toEqual(expect.arrayContaining(['en', 'bn']));
    for (const key of ['home', 'friends', 'messages', 'post', 'aiBot', 'demoMode']) {
      expect(LOCALES.en[key]).toBeTruthy();
      expect(LOCALES.bn[key]).toBeTruthy();
    }
  });
  it('translates and falls back to English for missing keys', () => {
    expect(t('home', 'en')).toBe('Home');
    expect(t('home', 'bn')).toBe('হোম');
    expect(t('nonexistent-key', 'bn')).toBe('nonexistent-key');
  });
  it('switches the active locale', () => {
    setLocale('bn');
    expect(getLocale()).toBe('bn');
    expect(t('post')).toBe(LOCALES.bn.post);
    setLocale('xx');
    expect(getLocale()).toBe('bn'); // unknown locale ignored
    setLocale('en');
  });
});

describe('firebase-config', () => {
  it('defaults to the live meetbook project config', () => {
    const cfg = resolveFirebaseConfig({});
    expect(cfg.projectId).toBe('meetbook-5f491');
    expect(cfg.authDomain).toBe('meetbook-5f491.firebaseapp.com');
    expect(cfg.storageBucket).toBe('meetbook-5f491.firebasestorage.app');
    expect(cfg.appId).toContain('249684575470');
    expect(isConfigComplete(cfg)).toBe(true);
    expect(DEFAULT_FIREBASE_CONFIG.measurementId).toBe('');
  });
  it('env vars override defaults, blank env values do not', () => {
    const cfg = resolveFirebaseConfig({ VITE_FIREBASE_PROJECT_ID: 'other-proj', VITE_FIREBASE_API_KEY: '  ' });
    expect(cfg.projectId).toBe('other-proj');
    expect(cfg.apiKey).toBe(DEFAULT_FIREBASE_CONFIG.apiKey);
    const custom = resolveFirebaseConfig({ VITE_FIREBASE_API_KEY: 'KEY123' });
    expect(custom.apiKey).toBe('KEY123');
  });
  it('detects incomplete configs (demo fallback trigger)', () => {
    expect(isConfigComplete({})).toBe(false);
    expect(isConfigComplete({ apiKey: 'x', authDomain: 'y', projectId: 'z' })).toBe(false);
    expect(isConfigComplete(null)).toBe(false);
  });
});
