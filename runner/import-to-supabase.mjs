// MeetBook Phase 5 migration — Supabase IMPORT (one-off).
//
// Reads firestore-export.json (produced by runner/export-firestore.mjs
// via .github/workflows/export-firestore.yml) and loads it into the
// Supabase project:
//
//   a) Auth users: every non-bot exported user WITH an email gets a
//      Supabase Auth user created via the Admin API with the SAME id
//      as the Firestore uid — so public.users.id = auth.uid() and no
//      cross-reference anywhere needs remapping. Passwords are set
//      only where known (env: OFFICIAL_PASSWORD for the MeetBook
//      Official account, TEST_PASSWORD for MeetBook Test). Everyone
//      else uses forgot-password after cutover. Bot users get NO auth
//      user (they act through admin sessions, exactly as today).
//   b) Table rows: every collection is upserted into its table via
//      PostgREST with the service key (bypasses RLS). Doc fields that
//      are schema columns go in as-is (light type coercion); fields
//      with no column go to the table's overflow jsonb column where
//      the schema defines one (config.extra, botConversations.payload)
//      and are otherwise dropped with a warning (field name + doc id).
//
// The service key is used ONLY by this one-off script, from env, and
// is never committed. botSecrets contents are NEVER printed — counts
// only, like every other table.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (required),
//      OFFICIAL_PASSWORD, TEST_PASSWORD (optional),
//      EXPORT_FILE (optional path to firestore-export.json).
// Exit code is 1 if anything failed, so the operator notices.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set — cannot run.');
  process.exit(1);
}
const OFFICIAL_EMAIL = 'meetbook.official@example.com';
const TEST_EMAIL = 'meetbook.test@example.com';

// ---------------------------------------------------------------------
// Column map — transcribed 1:1 from schema.sql (Phase 1). Types drive
// light coercion only; names are the exact quoted identifiers, so
// PostgREST payloads use the Firestore field names unchanged.
// overflow: jsonb column that absorbs doc fields with no column.
// ---------------------------------------------------------------------
const T = 'text', B = 'bigint', I = 'int', BO = 'bool', J = 'jsonb', TA = 'text[]';
const TABLE_SPECS = {
  users: { overflow: null, columns: {
    id: T, name: T, username: T, email: T, bio: T, avatar: T, cover: T, work: T, education: T,
    currentCity: T, hometown: T, relationship: T, website: T, nickname: T, dob: T, gender: T,
    role: T, isBot: BO, botId: T, status: T, verified: BO, online: BO, lastSeen: B, createdAt: B,
    followers: J, following: J, closeFriends: J, settings: J } },
  posts: { overflow: null, columns: {
    id: T, authorId: T, text: T, image: T, visibility: T, audienceIds: TA, createdAt: B, editedAt: B,
    likes: J, reactions: J, comments: J, shares: I, sharedFrom: T, savedBy: J, groupId: T, pageId: T,
    pageName: T, pageAvatar: T, poll: J, location: T, feeling: T, pinned: BO } },
  stories: { overflow: null, columns: {
    id: T, authorId: T, image: T, text: T, bg: T, visibility: T, audienceIds: TA, views: J, createdAt: B } },
  groups: { overflow: null, columns: {
    id: T, name: T, description: T, privacy: T, cover: T, createdBy: T, members: TA, createdAt: B } },
  groupRequests: { overflow: null, columns: {
    id: T, groupId: T, groupOwnerId: T, userId: T, status: T, createdAt: B } },
  pages: { overflow: null, columns: {
    id: T, name: T, category: T, about: T, avatar: T, cover: T, ownerId: T, followers: J, createdAt: B } },
  reviews: { overflow: null, columns: {
    id: T, pageId: T, authorId: T, rating: I, text: T, createdAt: B } },
  events: { overflow: null, columns: {
    id: T, title: T, description: T, dateTime: B, location: T, cover: T, createdBy: T, visibility: T,
    audienceIds: TA, going: J, interested: J, createdAt: B } },
  conversations: { overflow: null, columns: {
    id: T, participants: TA, isGroup: BO, title: T, createdBy: T, createdAt: B, typing: J, theme: T,
    emoji: T, nicknames: J, archivedBy: J, mutedBy: J, pinnedBy: J, acceptedBy: J, mutedUntil: J,
    vanish: BO, joinCode: T } },
  invites: { overflow: null, columns: {
    id: T, conversationId: T, createdBy: T, createdAt: B } },
  messages: { overflow: null, columns: {
    id: T, conversationId: T, participants: TA, senderId: T, text: T, image: T, audio: T, createdAt: B,
    status: T, readBy: J, reactions: J, pinned: BO, pinnedBy: T, pinnedAt: B, editedAt: B, unsent: BO,
    hiddenFor: J, forwarded: BO, sticker: T, location: J, poll: J, file: J, vanish: BO, expiresAt: B,
    mentions: J, replyToId: T, replyToName: T, replyToText: T } },
  friendships: { overflow: null, columns: {
    id: T, from: T, to: T, status: T, createdAt: B } },
  blocks: { overflow: null, columns: {
    id: T, by: T, target: T, createdAt: B } },
  notifications: { overflow: null, columns: {
    id: T, userId: T, type: T, actorId: T, text: T, postId: T, conversationId: T, groupId: T,
    pageId: T, eventId: T, read: BO, createdAt: B } },
  reports: { overflow: null, columns: {
    id: T, reporterId: T, targetType: T, targetId: T, targetAuthorId: T, targetLabel: T,
    targetPhoto: BO, reason: T, category: T, status: T, decision: J, appeal: J, evidence: J, createdAt: B } },
  adminLogs: { overflow: null, columns: {
    id: T, adminId: T, adminName: T, action: T, targetType: T, targetId: T, targetLabel: T, reason: T, createdAt: B } },
  announcements: { overflow: null, columns: {
    id: T, title: T, body: T, createdBy: T, createdByName: T, createdAt: B, active: BO } },
  bots: { overflow: null, columns: {
    id: T, name: T, username: T, avatar: T, bio: T, model: T, provider: T, isBot: BO, active: BO,
    personality: J, limits: J, createdAt: B } },
  botBrains: { overflow: null, columns: {
    id: T, botId: T, systemPrompt: T, provider: T, model: T, updatedAt: B } },
  botMemories: { overflow: null, columns: {
    id: T, botId: T, items: J } },
  botConversations: { overflow: 'payload', columns: {
    id: T, botId: T, conversationId: T, payload: J, updatedAt: B } },
  botActivities: { overflow: null, columns: {
    id: T, botId: T, action: T, detail: T, status: T, createdAt: B } },
  botLogs: { overflow: null, columns: {
    id: T, botId: T, level: T, message: T, createdAt: B } },
  botRunners: { overflow: null, columns: {
    id: T, kind: T, window: B, by: T, status: T, botId: T, items: J, createdAt: B, updatedAt: B } },
  botSettings: { overflow: null, columns: {
    id: T, enabled: BO, day: T, counters: J, updatedAt: B } },
  botSecrets: { overflow: null, columns: {
    id: T, geminiApiKey: T, providers: J, aiUsage: J, updatedAt: B } },
  config: { overflow: 'extra', columns: {
    id: T, maintenanceMode: BO, registrationOpen: BO, platformName: T, defaultLanguage: T,
    aiFallbackOrder: J, aiPaidApproved: BO, extra: J } }
};

// Insert order: referenced rows first (no FK constraints exist in the
// schema, but keep the dependency order anyway).
const INSERT_ORDER = [
  'users', 'bots', 'config', 'botSettings', 'botSecrets', 'botBrains', 'botMemories',
  'botConversations', 'posts', 'stories', 'groups', 'pages', 'events', 'groupRequests',
  'reviews', 'conversations', 'invites', 'messages', 'friendships', 'blocks',
  'notifications', 'reports', 'adminLogs', 'announcements', 'botActivities', 'botLogs', 'botRunners'
];

// ---------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------
const DROP = Symbol('drop');
const warnings = []; // { table, id, field, why } — field names + ids only, NEVER values

function coerce(type, value, table, id, field) {
  if (value === null || value === undefined) return DROP; // column default / null applies
  switch (type) {
    case T:
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      break;
    case B: case I: {
      const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
      if (Number.isFinite(n)) return Math.trunc(n);
      break;
    }
    case BO:
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 'true') return true;
      if (value === 0 || value === 'false') return false;
      break;
    case TA:
      if (Array.isArray(value)) return value.filter((x) => ['string', 'number', 'boolean'].includes(typeof x)).map(String);
      break;
    case J:
      return value; // any JSON value is valid jsonb
  }
  warnings.push({ table, id, field, why: `type mismatch for ${type} column — field dropped` });
  return DROP;
}

function mapRow(table, doc) {
  const spec = TABLE_SPECS[table];
  const row = { id: doc.__id };
  const extra = {};
  for (const [field, value] of Object.entries(doc)) {
    if (field === '__id') continue;
    if (field === 'id') {
      if (value !== doc.__id) warnings.push({ table, id: doc.__id, field, why: 'embedded id differs from doc id — doc id kept' });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(spec.columns, field)) {
      const c = coerce(spec.columns[field], value, table, doc.__id, field);
      if (c !== DROP) row[field] = c;
    } else if (spec.overflow) {
      extra[field] = value;
    } else {
      warnings.push({ table, id: doc.__id, field, why: 'no column and no overflow — field dropped' });
    }
  }
  if (spec.overflow && Object.keys(extra).length) {
    const base = row[spec.overflow] && typeof row[spec.overflow] === 'object' && !Array.isArray(row[spec.overflow]) ? row[spec.overflow] : {};
    row[spec.overflow] = { ...base, ...extra };
  }
  return row;
}

// ---------------------------------------------------------------------
// HTTP helpers (service key — bypasses RLS; used only by this script)
// ---------------------------------------------------------------------
const serviceHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

async function createAuthUser(user, password) {
  const body = { id: user.__id, email: user.email, email_confirm: true, user_metadata: { name: user.name || '', username: user.username || '', migratedFrom: 'firestore' } };
  if (password) body.password = password;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, { method: 'POST', headers: serviceHeaders, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    if (data.id && data.id !== user.__id) return { status: 'id-mismatch', detail: `auth id ${data.id} != firestore uid ${user.__id}` };
    return { status: password ? 'created (password set)' : 'created (no password — forgot-password)' };
  }
  const msg = String(data.msg || data.message || data.error_description || res.status);
  if (/already|exists|registered/i.test(msg)) return { status: 'already exists — skipped' };
  return { status: 'FAILED', detail: msg.slice(0, 200) };
}

async function upsertChunk(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { ...serviceHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (res.ok) return null;
  const text = await res.text().catch(() => '');
  return `HTTP ${res.status}: ${text.slice(0, 200)}`;
}

// Byte-aware chunking: voice-message audio is base64, so row counts
// alone do not bound payload size.
function chunkRows(rows, maxRows = 100, maxBytes = 3_000_000) {
  const chunks = [];
  let cur = [], bytes = 2;
  for (const r of rows) {
    const b = JSON.stringify(r).length + 1;
    if (cur.length && (cur.length >= maxRows || bytes + b > maxBytes)) { chunks.push(cur); cur = []; bytes = 2; }
    cur.push(r); bytes += b;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function countTable(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=id`, {
    headers: { ...serviceHeaders, 'Range-Unit': 'items', Range: '0-0', Prefer: 'count=exact' }
  });
  const cr = res.headers.get('content-range') || '';
  const total = Number(cr.split('/')[1]);
  return Number.isFinite(total) ? total : -1;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
function loadExport() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.EXPORT_FILE,
    join(process.cwd(), 'firestore-export.json'),
    join(here, '..', 'firestore-export.json'),
    join(here, 'firestore-export.json')
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) { console.log(`Reading export: ${p}`); return JSON.parse(readFileSync(p, 'utf8')); }
  }
  console.error(`firestore-export.json not found (looked in: ${candidates.join(', ')}). Set EXPORT_FILE.`);
  process.exit(1);
}

async function main() {
  const data = loadExport();
  const collections = data.collections || {};
  let failures = 0;

  // --- (a) Auth users -------------------------------------------------
  console.log('\n== Auth users ==');
  const users = collections.users || [];
  const authStats = { created: 0, existed: 0, failed: 0, skippedBot: 0, skippedNoEmail: 0, idMismatch: 0 };
  for (const u of users) {
    if (u.isBot === true) { authStats.skippedBot++; continue; }
    if (!u.email || typeof u.email !== 'string') { authStats.skippedNoEmail++; console.log(`  skip (no email): user ${u.__id}`); continue; }
    const em = u.email.toLowerCase();
    let password = null;
    if (em === OFFICIAL_EMAIL || u.username === 'meetbook.official') password = process.env.OFFICIAL_PASSWORD || null;
    else if (em === TEST_EMAIL || u.username === 'meetbook.test') password = process.env.TEST_PASSWORD || null;
    if ((em === OFFICIAL_EMAIL || em === TEST_EMAIL) && !password) {
      console.log(`  WARNING: ${u.email} has a known password slot but the env var is empty — it will need forgot-password.`);
    }
    try {
      const r = await createAuthUser(u, password);
      if (r.status === 'FAILED') { authStats.failed++; failures++; console.log(`  FAILED ${u.email}: ${r.detail}`); }
      else if (r.status === 'id-mismatch') { authStats.idMismatch++; failures++; console.log(`  ⚠️ ID MISMATCH ${u.email}: ${r.detail} — this user's rows keep the old uid; needs manual remap.`); }
      else if (r.status.startsWith('already')) { authStats.existed++; console.log(`  exists: ${u.email}`); }
      else { authStats.created++; console.log(`  ${r.status}: ${u.email}`); }
    } catch (err) {
      authStats.failed++; failures++;
      console.log(`  FAILED ${u.email}: ${err.message}`);
    }
  }
  console.log(`Auth summary: created ${authStats.created}, already existed ${authStats.existed}, failed ${authStats.failed}, id mismatches ${authStats.idMismatch}, bots skipped ${authStats.skippedBot}, no-email skipped ${authStats.skippedNoEmail}.`);

  // --- (b) Table rows ---------------------------------------------------
  console.log('\n== Tables ==');
  const results = [];
  for (const table of INSERT_ORDER) {
    const docs = collections[table] || [];
    const rows = docs.map((d) => mapRow(table, d));
    let ok = 0, failed = 0;
    for (const chunk of chunkRows(rows)) {
      const err = await upsertChunk(table, chunk);
      if (!err) { ok += chunk.length; continue; }
      // Isolate bad rows: retry one by one so a single bad row never
      // blocks the rest of the table.
      for (const row of chunk) {
        const e2 = await upsertChunk(table, [row]);
        if (e2) { failed++; failures++; console.error(`  ${table}/${row.id}: FAILED — ${e2}`); }
        else ok++;
      }
    }
    const inDb = await countTable(table).catch(() => -1);
    results.push({ table, exported: docs.length, sent: ok, failed, inDb });
    console.log(`  ${table}: exported ${docs.length}, upserted ${ok}, failed ${failed}, in DB ${inDb}`);
  }

  // --- Warnings (field names + doc ids only — never values) ------------
  if (warnings.length) {
    console.log(`\n== Mapping warnings (${warnings.length}) ==`);
    for (const w of warnings.slice(0, 50)) console.log(`  ${w.table}/${w.id}: field "${w.field}" — ${w.why}`);
    if (warnings.length > 50) console.log(`  … and ${warnings.length - 50} more`);
  }

  // --- Final comparison --------------------------------------------------
  console.log('\n== Final comparison (export vs DB) ==');
  let mismatch = 0;
  for (const r of results) {
    const flag = r.inDb === r.exported ? '✓' : '✗ MISMATCH';
    if (r.inDb !== r.exported) mismatch++;
    console.log(`  ${flag} ${r.table}: export ${r.exported} / DB ${r.inDb}`);
  }
  if (mismatch) { failures += mismatch; console.log(`⚠️ ${mismatch} table(s) differ — likely duplicate-id collisions inside the export (upsert merged them) or failed rows above. Investigate before cutover.`); }

  console.log(failures ? `\nImport finished WITH ${failures} failure(s). Review the log before cutover.` : '\nImport finished cleanly.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`Import failed: ${err.stack || err.message}`);
  process.exit(1);
});
