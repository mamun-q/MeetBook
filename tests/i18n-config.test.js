import { describe, it, expect } from 'vitest';
import { t, setLocale, getLocale, availableLocales, LOCALES } from '../src/i18n.js';
import { resolveSupabaseConfig, isSupabaseConfigComplete, DEFAULT_SUPABASE_CONFIG } from '../src/supabase.js';

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

describe('supabase-config', () => {
  it('defaults to the live meetbook project config', () => {
    const cfg = resolveSupabaseConfig({});
    expect(cfg.url).toBe('https://ouyuijpxhhvtnxnvavza.supabase.co');
    expect(cfg.projectRef).toBe('ouyuijpxhhvtnxnvavza');
    expect(cfg.publishableKey).toMatch(/^sb_publishable_/);
    expect(isSupabaseConfigComplete(cfg)).toBe(true);
    expect(DEFAULT_SUPABASE_CONFIG.url).toContain('ouyuijpxhhvtnxnvavza.supabase.co');
  });
  it('env vars override defaults, blank env values do not', () => {
    const cfg = resolveSupabaseConfig({ VITE_SUPABASE_PROJECT_REF: 'other-proj', VITE_SUPABASE_PUBLISHABLE_KEY: '  ' });
    expect(cfg.projectRef).toBe('other-proj');
    expect(cfg.publishableKey).toBe(DEFAULT_SUPABASE_CONFIG.publishableKey);
    const custom = resolveSupabaseConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: 'KEY123' });
    expect(custom.publishableKey).toBe('KEY123');
  });
  it('detects incomplete configs (demo fallback trigger)', () => {
    expect(isSupabaseConfigComplete({})).toBe(false);
    expect(isSupabaseConfigComplete({ url: 'https://x.supabase.co' })).toBe(false);
    expect(isSupabaseConfigComplete(null)).toBe(false);
  });
});
