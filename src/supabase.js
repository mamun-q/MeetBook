// Supabase initialisation (Firebase → Supabase migration, Phase 2).
// Config resolution: VITE_SUPABASE_* env vars override the committed
// default project config below, so the app runs in LIVE Supabase mode
// by default. Demo/offline mode is only a fallback if the config is
// removed or initialisation fails.
//
// The publishable (anon) key is NOT a secret: it identifies the
// project to client apps and is designed to be shipped in public web
// code. Access is controlled by Supabase Auth + Postgres Row Level
// Security, never by hiding this key. Real secrets (AI provider keys,
// the service_role key) must NEVER appear here — provider keys live in
// the admin-only botSecrets table; no service_role key exists in the
// client at all.
import { createClient } from '@supabase/supabase-js';

export const DEFAULT_SUPABASE_CONFIG = {
  url: 'https://ouyuijpxhhvtnxnvavza.supabase.co',
  publishableKey: 'sb_publishable_-hldx2wyXfAjxFLAZf4sHA_uu72VfTn',
  projectRef: 'ouyuijpxhhvtnxnvavza'
};

export function resolveSupabaseConfig(env = {}) {
  const pick = (key, fallback) => {
    const v = env[key];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
  };
  return {
    url: pick('VITE_SUPABASE_URL', DEFAULT_SUPABASE_CONFIG.url),
    publishableKey: pick('VITE_SUPABASE_PUBLISHABLE_KEY', DEFAULT_SUPABASE_CONFIG.publishableKey),
    projectRef: pick('VITE_SUPABASE_PROJECT_REF', DEFAULT_SUPABASE_CONFIG.projectRef)
  };
}

export function isSupabaseConfigComplete(cfg) {
  return Boolean(cfg && cfg.url && cfg.publishableKey);
}

const cfg = resolveSupabaseConfig(import.meta.env || {});

export const supabaseConfig = cfg;
export const isSupabaseConfigured = isSupabaseConfigComplete(cfg);

let client = null;

if (isSupabaseConfigured) {
  try {
    client = createClient(cfg.url, cfg.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // PKCE keeps the OAuth return on the query string (?code=…)
        // instead of the hash fragment, which this app owns for its
        // hash-based routing (#/…).
        flowType: 'pkce',
        detectSessionInUrl: true
      }
    });
  } catch (err) {
    // Fall back to demo mode rather than crashing the whole app.
    console.error('Supabase init failed, falling back to demo mode:', err);
    client = null;
  }
}

export const supabase = client;
export const supabaseReady = Boolean(client);
