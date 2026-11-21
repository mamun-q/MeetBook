-- =====================================================================
-- MeetBook — Postgres schema for the Firebase → Supabase migration
-- Phase 1 deliverable. (Ordering fix 2026-11-22: the RLS helper
-- functions sit AFTER the tables they reference — Postgres refuses a
-- function whose return type is a table that does not exist yet.)
--
-- Source of truth for shapes: src/api.js write paths, src/utils.js
-- normalise* functions, src/botLogic.js, firestore.rules.
--
-- CONVENTIONS (from MIGRATION_PLAN.md design decisions — follow exactly)
--  1. Every table keeps its Firestore collection name and every column
--     keeps its Firestore field name, as QUOTED identifiers
--     ("groupRequests", "authorId", ...). Postgres folds unquoted names
--     to lowercase; quoting preserves the exact names so supabase-js
--     returns rows already shaped like Firestore documents and the
--     Phase 2 api.js rewrite needs no per-field rename mapping.
--  2. `id` is `text primary key` everywhere and holds the existing
--     Firestore document id (decision #2). Deterministic ids keep
--     working unchanged: friendships "<from>_<to>", blocks
--     "<by>_<target>", groupRequests "<groupId>_<userId>",
--     conversations "dm_<uidA>_<uidB>" (sorted pair), invites = the
--     join code itself, botRunners "autocycle_<windowKey>" /
--     "decisions_<botId>", singletons config/'app',
--     botSecrets/'config', botSettings/'global' + 'counters'.
--  3. ALL timestamps are `bigint` epoch-milliseconds, exactly as the
--     app stores them today (Date.now(); serverTimestamp() on
--     posts/stories createdAt is normalised back to ms by
--     normaliseTimeFields in the mirror). The app compares times
--     against Date.now() in dozens of places; switching to
--     timestamptz would force conversions through the whole codebase
--     for zero user-visible gain. Rejected deliberately.
--  4. Firestore-shaped arrays/maps → jsonb (decision #3), EXCEPT the
--     uid arrays that queries FILTER on (Firestore array-contains),
--     which become `text[]` + GIN so the Postgres query is the direct
--     equivalent: posts."audienceIds", stories."audienceIds",
--     events."audienceIds", conversations.participants,
--     messages.participants, groups.members.
--  5. users.id for humans will hold the NEW Supabase auth.users id
--     (as text) after the Phase 5 uid remap; bot profile rows keep
--     their "bot_..." ids and have NO auth.users row (bots never sign
--     in — the runner signs in as the Official admin and writes as
--     them, same as today).
--  6. RLS is enabled on every table at the bottom of this file. The
--     policies themselves are specified in RLS_NOTES.md and land as a
--     separate policies migration in Phase 1b/2 — with RLS enabled and
--     no policies, a table is deny-all for anon/authenticated roles,
--     which is the safe default while staging.
--
-- COMMENTS DECISION (posts.comments): Firestore has NO comments
-- collection and NO posts/{id}/comments subcollection — comments are
-- an embedded array on the post document (api.js addComment /
-- deleteComment rewrite the whole array; replies nest one level deep
-- inside each comment). There is therefore no comments table. The
-- array maps to posts.comments jsonb with the exact item shape:
--   { id, authorId, text, createdAt,
--     replies: [ { id, authorId, text, createdAt, replies: [] } ] }
-- Why not normalise into a table: (a) every read of comments happens
-- together with its post; (b) every write replaces the whole array —
-- a table would make each comment add/delete a multi-row transaction
-- and force api.js to reassemble arrays on every read, breaking the
-- "identical shapes" decision for the single hottest document type;
-- (c) Firestore gives comments NO independent security rule (they ride
-- the posts update rule), so a table would invent permissions the app
-- never had. Revisit only if per-comment moderation queries ever
-- become a product need.
-- =====================================================================

begin;

-- =====================================================================
-- users — Firestore: users/{uid}
-- Written by register()/loginWithGoogle() (self profile), botUserProfile
-- (bot profiles, role 'bot'), updateProfile, admin user management.
-- =====================================================================
create table public.users (
  id            text primary key,
  name          text not null default '',
  username      text not null default '',
  email         text not null default '',
  bio           text not null default '',
  avatar        text not null default '',
  cover         text not null default '',
  work          text not null default '',
  education     text not null default '',
  "currentCity" text not null default '',
  hometown      text not null default '',
  relationship  text not null default '',
  website       text not null default '',
  nickname      text not null default '',
  dob           text not null default '',
  gender        text not null default '',
  -- role ladder: 'user' | 'analyst' | 'moderator' | 'admin' |
  -- 'superadmin' | 'bot' (bots only). Pinned in RLS: only a
  -- superadmin may change role/"isBot" (see RLS_NOTES.md).
  role          text not null default 'user',
  "isBot"       boolean not null default false,
  "botId"       text,                    -- bot profile docs only (= id)
  status        text not null default 'active',  -- 'active'|'suspended'|'banned'
  verified      boolean not null default false,
  online        boolean not null default false,
  "lastSeen"    bigint not null default 0,
  "createdAt"   bigint not null default 0,
  followers     jsonb not null default '[]'::jsonb,  -- [uid]
  following     jsonb not null default '[]'::jsonb,  -- [uid]
  "closeFriends" jsonb not null default '[]'::jsonb, -- [uid]
  settings      jsonb not null default '{}'::jsonb
);
-- register/loginWithGoogle probe where('username','==',v) for the
-- uniqueness check; usernames are stored lowercased by validateUsername.
create unique index users_username_key on public.users (username);
create index users_created_idx on public.users ("createdAt" desc);

-- =====================================================================
-- posts — Firestore: posts/{postId} (comments embedded — see header)
-- Hot reads: visibility='public' order by createdAt desc limit 100;
-- authorId = me; audienceIds contains me; groupId = X; pageId = X.
-- =====================================================================
create table public.posts (
  id            text primary key,
  "authorId"    text not null,
  text          text not null default '',
  image         text not null default '',   -- Cloudinary URL or data URL
  visibility    text not null default 'public', -- 'public'|'friends'|'private'|'close-friends' (postAudience output)
  "audienceIds" text[] not null default '{}',   -- denormalised audience snapshot
  "createdAt"   bigint not null default 0,
  "editedAt"    bigint not null default 0,
  likes         jsonb not null default '[]'::jsonb,  -- [uid]
  reactions     jsonb not null default '{}'::jsonb,  -- { uid: emoji }
  comments      jsonb not null default '[]'::jsonb,  -- [{id,authorId,text,createdAt,replies:[…]}]
  shares        integer not null default 0,
  "sharedFrom"  text not null default '',   -- original author's uid on shares
  "savedBy"     jsonb not null default '[]'::jsonb,  -- [uid]
  "groupId"     text not null default '',
  "pageId"      text not null default '',
  "pageName"    text not null default '',   -- snapshot at post time
  "pageAvatar"  text not null default '',   -- snapshot at post time
  poll          jsonb,                      -- { options: [{id, text}], votes: { uid: optionId } } | null
  location      text not null default '',
  feeling       text not null default '',
  pinned        boolean not null default false  -- group announcement pin
);
create index posts_public_feed_idx on public.posts ("createdAt" desc) where visibility = 'public';
create index posts_author_idx on public.posts ("authorId", "createdAt" desc);
create index posts_audience_gin on public.posts using gin ("audienceIds");
create index posts_group_idx on public.posts ("groupId") where "groupId" <> '';
create index posts_page_idx on public.posts ("pageId") where "pageId" <> '';

-- =====================================================================
-- stories — Firestore: stories/{storyId} (24h life is a client filter)
-- Same three listeners as posts: public / authorId = me / audience.
-- =====================================================================
create table public.stories (
  id            text primary key,
  "authorId"    text not null,
  image         text not null default '',
  text          text not null default '',
  bg            text not null default 'sunset',
  visibility    text not null default 'public',
  "audienceIds" text[] not null default '{}',
  views         jsonb not null default '[]'::jsonb,  -- [uid]
  "createdAt"   bigint not null default 0
);
create index stories_public_idx on public.stories ("createdAt" desc) where visibility = 'public';
create index stories_author_idx on public.stories ("authorId", "createdAt" desc);
create index stories_audience_gin on public.stories using gin ("audienceIds");

-- =====================================================================
-- groups — Firestore: groups/{groupId} (normaliseGroup)
-- Reads: privacy='public' limit 200; members contains me limit 200.
-- =====================================================================
create table public.groups (
  id          text primary key,
  name        text not null default '',
  description text not null default '',
  privacy     text not null default 'public',  -- 'public'|'private'
  cover       text not null default '',
  "createdBy" text not null,
  members     text[] not null default '{}',
  "createdAt" bigint not null default 0
);
create index groups_privacy_idx on public.groups (privacy);
create index groups_members_gin on public.groups using gin (members);

-- =====================================================================
-- groupRequests — Firestore: groupRequests/{groupId}_{userId}
-- groupOwnerId is denormalised so both client queues (userId = me,
-- groupOwnerId = me) are single-column filters, as in Firestore.
-- =====================================================================
create table public."groupRequests" (
  id            text primary key,
  "groupId"     text not null,
  "groupOwnerId" text not null,
  "userId"      text not null,
  status        text not null default 'pending',  -- 'pending'|'approved'|'rejected'
  "createdAt"   bigint not null default 0
);
create index group_requests_user_idx on public."groupRequests" ("userId");
create index group_requests_owner_idx on public."groupRequests" ("groupOwnerId");

-- =====================================================================
-- pages — Firestore: pages/{pageId} (normalisePage)
-- Read pattern: full list limit 200 (public to signed-in users).
-- =====================================================================
create table public.pages (
  id          text primary key,
  name        text not null default '',
  category    text not null default 'Community',
  about       text not null default '',
  avatar      text not null default '',
  cover       text not null default '',
  "ownerId"   text not null,
  followers   jsonb not null default '[]'::jsonb,  -- [uid]
  "createdAt" bigint not null default 0
);
create index pages_owner_idx on public.pages ("ownerId");

-- =====================================================================
-- reviews — Firestore: reviews/{reviewId}
-- Read pattern: order by createdAt desc limit 500, filtered by pageId
-- client-side. One review per user per page is a client invariant in
-- Firestore (saveReview upserts); the unique index below makes it a
-- database guarantee in Postgres — a deliberate, safe strengthening.
-- =====================================================================
create table public.reviews (
  id          text primary key,
  "pageId"    text not null,
  "authorId"  text not null,
  rating      smallint not null check (rating between 1 and 5),
  text        text not null default '',
  "createdAt" bigint not null default 0
);
create unique index reviews_page_author_key on public.reviews ("pageId", "authorId");
create index reviews_created_idx on public.reviews ("createdAt" desc);

-- =====================================================================
-- events — Firestore: events/{eventId} (normaliseEvent)
-- Listeners: visibility='public' order by dateTime asc limit 100;
-- createdBy = me; audienceIds contains me.
-- =====================================================================
create table public.events (
  id            text primary key,
  title         text not null default '',
  description   text not null default '',
  "dateTime"    bigint not null default 0,
  location      text not null default '',
  cover         text not null default '',
  "createdBy"   text not null,
  visibility    text not null default 'public',
  "audienceIds" text[] not null default '{}',
  going         jsonb not null default '[]'::jsonb,  -- [uid]
  interested    jsonb not null default '[]'::jsonb,  -- [uid]
  "createdAt"   bigint not null default 0
);
create index events_public_idx on public.events ("dateTime" asc) where visibility = 'public';
create index events_creator_idx on public.events ("createdBy");
create index events_audience_gin on public.events using gin ("audienceIds");

-- =====================================================================
-- conversations — Firestore: conversations/{convId}
-- 1-1 ids are deterministic "dm_<uidA>_<uidB>" (sorted pair); group
-- chats get random ids and carry isGroup/title/createdBy. Read
-- pattern: participants contains me (the chat list).
-- =====================================================================
create table public.conversations (
  id            text primary key,
  participants  text[] not null default '{}',
  "isGroup"     boolean not null default false,
  title         text not null default '',
  "createdBy"   text not null default '',   -- group chats only
  "createdAt"   bigint not null default 0,
  typing        jsonb not null default '{}'::jsonb,  -- { uid: epochMs } heartbeat
  theme         text,                                -- chat theme id | null
  emoji         text,                                -- per-thread quick emoji | null
  nicknames     jsonb not null default '{}'::jsonb,  -- { uid: nickname }
  "archivedBy"  jsonb not null default '[]'::jsonb,  -- [uid]
  "mutedBy"     jsonb not null default '[]'::jsonb,  -- [uid]
  "pinnedBy"    jsonb not null default '[]'::jsonb,  -- [uid]
  "acceptedBy"  jsonb not null default '[]'::jsonb,  -- [uid] message-request accepts
  "mutedUntil"  jsonb not null default '{}'::jsonb,  -- { uid: epochMs }
  vanish        boolean not null default false,
  "joinCode"    text not null default ''    -- live invite code (invites.id) | ''
);
create index conversations_participants_gin on public.conversations using gin (participants);
create index conversations_join_code_idx on public.conversations ("joinCode") where "joinCode" <> '';

-- =====================================================================
-- invites — Firestore: invites/{code} (the doc id IS the secret code)
-- =====================================================================
create table public.invites (
  id              text primary key,          -- the join code
  "conversationId" text not null,
  "createdBy"     text not null,
  "createdAt"     bigint not null default 0
);
create index invites_conversation_idx on public.invites ("conversationId");

-- =====================================================================
-- messages — Firestore: messages/{msgId}
-- participants is DENORMALISED from the conversation at send time —
-- the chat listener is: participants contains me, order by createdAt
-- desc, limit 500 (newest 500). Per-thread reads use conversationId +
-- createdAt desc (runner: latest message per conversation).
-- =====================================================================
create table public.messages (
  id              text primary key,
  "conversationId" text not null,
  participants    text[] not null default '{}',  -- send-time snapshot
  "senderId"      text not null,
  text            text not null default '',
  image           text not null default '',
  audio           text not null default '',      -- base64 data URL (voice, ≤60s)
  "createdAt"     bigint not null default 0,
  status          text not null default 'sent',  -- 'sent'|'read'
  "readBy"        jsonb not null default '[]'::jsonb,  -- [uid]
  reactions       jsonb,                              -- { emoji: [uid] } | null
  pinned          boolean not null default false,
  "pinnedBy"      text not null default '',
  "pinnedAt"      bigint not null default 0,
  "editedAt"      bigint,                             -- null until first edit
  unsent          boolean not null default false,     -- unsend tombstone
  "hiddenFor"     jsonb not null default '[]'::jsonb, -- [uid] remove-for-me
  forwarded       boolean not null default false,
  sticker         text not null default '',           -- one big emoji
  location        jsonb,                              -- { lat, lng } | null
  poll            jsonb,                              -- { options: [{id, text, votes: [uid]}] } | null (chat-poll shape — differs from post polls)
  file            jsonb,                              -- { name, size, type, url } | null
  vanish          boolean not null default false,
  "expiresAt"     bigint,                             -- vanish expiry | null
  mentions        jsonb,                              -- [uid] group-chat @mentions | null
  "replyToId"     text,                               -- quoted message id | null
  "replyToName"   text,                               -- quoted author name snapshot
  "replyToText"   text                                -- quoted ≤120-char snippet
);
create index messages_participants_gin on public.messages using gin (participants);
create index messages_conv_idx on public.messages ("conversationId", "createdAt" desc);
create index messages_feed_idx on public.messages ("createdAt" desc);

-- =====================================================================
-- friendships — Firestore: friendships/{from}_{to}
-- Listeners: from = me; to = me.
-- =====================================================================
create table public.friendships (
  id          text primary key,              -- "<from>_<to>"
  "from"      text not null,
  "to"        text not null,
  status      text not null default 'pending',  -- 'pending'|'accepted'
  "createdAt" bigint not null default 0
);
create index friendships_from_idx on public.friendships ("from");
create index friendships_to_idx on public.friendships ("to");
create unique index friendships_pair_key on public.friendships ("from", "to");

-- =====================================================================
-- blocks — Firestore: blocks/{by}_{target}
-- Listener: by = me.
-- =====================================================================
create table public.blocks (
  id          text primary key,              -- "<by>_<target>"
  by          text not null,
  target      text not null,
  "createdAt" bigint not null default 0
);
create index blocks_by_idx on public.blocks (by);

-- =====================================================================
-- notifications — Firestore: notifications/{id}
-- Listener: userId = me, order by createdAt desc, limit 100.
-- postId/conversationId are the deep-link fields; groupId/pageId/
-- eventId are stamped on the group/page/event notification types.
-- =====================================================================
create table public.notifications (
  id              text primary key,
  "userId"        text not null,
  type            text not null default '',  -- like|comment|reply|mention|message|friend_request|friend_accept|share|warning|report_decision|moderation_notice|appeal_decision|group_request|group_join|group_request_result|page_follow|event_rsvp|admin|…
  "actorId"       text not null default '',
  text            text not null default '',
  "postId"        text not null default '',
  "conversationId" text not null default '',
  "groupId"       text not null default '',
  "pageId"        text not null default '',
  "eventId"       text not null default '',
  read            boolean not null default false,
  "createdAt"     bigint not null default 0
);
create index notifications_user_idx on public.notifications ("userId", "createdAt" desc);

-- =====================================================================
-- reports — Firestore: reports/{id} (Pack B + Support Inbox)
-- targetAuthorId / targetLabel / targetPhoto are stamped at creation
-- because a 'content-removed' decision HARD-deletes the target — the
-- author and the readable snapshot must already be on the report.
-- Listeners: staff full list (createdAt desc, limit 100); inbox slices
-- reporterId = me and targetAuthorId = me.
-- =====================================================================
create table public.reports (
  id              text primary key,
  "reporterId"    text not null,
  "targetType"    text not null default '',  -- 'post'|'comment'|'message'|'user'
  "targetId"      text not null default '',
  "targetAuthorId" text not null default '',
  "targetLabel"   text not null default '',  -- ≤120-char snapshot
  "targetPhoto"   boolean not null default false,
  reason          text not null default '',
  category        text not null default 'other',
  status          text not null default 'pending',  -- 'pending'|'review'|'resolved'|'rejected'|'escalated'
  decision        jsonb,                     -- { byId, byName, at, reason, outcome, action } | null
  appeal          jsonb not null default '{"status": "none"}'::jsonb,
                                             -- { status: 'none'|'requested'|'accepted'|'declined',
                                             --   text, byId, byName, at, reason }
  evidence        jsonb,                     -- message reports only:
                                             -- { messageId, text, senderId, conversationId }
  "createdAt"     bigint not null default 0
);
create index reports_reporter_idx on public.reports ("reporterId");
create index reports_target_author_idx on public.reports ("targetAuthorId");
create index reports_created_idx on public.reports ("createdAt" desc);

-- =====================================================================
-- adminLogs — Firestore: adminLogs/{id} (append-only audit trail)
-- Listener (admins only): order by createdAt desc, limit 200.
-- =====================================================================
create table public."adminLogs" (
  id            text primary key,
  "adminId"     text not null,
  "adminName"   text not null default '',
  action        text not null default '',    -- 'set-role'|'suspend-user'|'report-resolve'|'bot-create'|…
  "targetType"  text not null default '',    -- 'user'|'post'|'report'|'config'|'bot'|'announcement'
  "targetId"    text not null default '',
  "targetLabel" text not null default '',
  reason        text not null default '',
  "createdAt"   bigint not null default 0
);
create index admin_logs_created_idx on public."adminLogs" ("createdAt" desc);

-- =====================================================================
-- announcements — Firestore: announcements/{id} (Pack C)
-- Listener: order by createdAt desc, limit 50 (all signed-in users).
-- =====================================================================
create table public.announcements (
  id            text primary key,
  title         text not null default '',
  body          text not null default '',
  "createdBy"   text not null default '',
  "createdByName" text not null default '',
  "createdAt"   bigint not null default 0,
  active        boolean not null default true
);
create index announcements_created_idx on public.announcements ("createdAt" desc);

-- =====================================================================
-- bots — Firestore: bots/{botId} (normaliseBot)
-- The bot's id is ALSO its users-row id (bot profile). Listener:
-- full list limit 100 (signed-in users — bot profiles are public).
-- =====================================================================
create table public.bots (
  id          text primary key,
  name        text not null default '',
  username    text not null default '',
  avatar      text not null default '',
  bio         text not null default '',
  model       text not null default '',      -- per-bot model override; '' = provider default
  provider    text not null default '',      -- per-bot provider; '' = platform routing
  "isBot"     boolean not null default true,
  active      boolean not null default true,
  personality jsonb not null default '{}'::jsonb,
              -- { traits: [..], tone, interests: [..], systemPrompt }
  limits      jsonb not null default '{}'::jsonb,
              -- { postsPerDay, commentsPerDay, likesPerDay,
              --   messagesPerDay, minIntervalMs } (DEFAULT_BOT_LIMITS)
  "createdAt" bigint not null default 0
);

-- =====================================================================
-- botBrains — Firestore: botBrains/{botId} (admin-only)
-- One row per bot: the live prompt + last-used provider/model stamps
-- (recordBotBrain maintains provider/model after every generation).
-- =====================================================================
create table public."botBrains" (
  id            text primary key,            -- = botId
  "botId"       text not null,
  "systemPrompt" text not null default '',
  provider      text not null default '',
  model         text not null default '',
  "updatedAt"   bigint not null default 0
);

-- =====================================================================
-- botMemories — Firestore: botMemories/{botId} (admin-only)
-- One row per bot; the whole memory list is one jsonb array, exactly
-- as stored today (the doc IS { botId, items: [...] }, cap 100,
-- upsert-dedup in botLogic.upsertMemory).
-- Item: { id, text, category ('conversation'|'experience'|'interest'|…),
--         createdAt, updatedAt, pinned }
-- =====================================================================
create table public."botMemories" (
  id      text primary key,                  -- = botId
  "botId" text not null,
  items   jsonb not null default '[]'::jsonb
);

-- =====================================================================
-- botConversations — Firestore: botConversations/{id} (admin-only)
-- NOTE: this collection exists ONLY in firestore.rules (Functions-era
-- design). No writer or reader exists in src/ or runner/ today — the
-- live bot admin derives conversation metadata on the fly in
-- loadBotAdminData() from conversations/messages. The table is kept
-- for parity so nothing the old engine wrote is orphaned by the move;
-- its shape is PROVISIONAL (botId + payload) until a real writer
-- appears. Do not build features on it.
-- =====================================================================
create table public."botConversations" (
  id          text primary key,
  "botId"     text not null default '',
  "conversationId" text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  "updatedAt" bigint not null default 0
);
create index bot_conversations_bot_idx on public."botConversations" ("botId");

-- =====================================================================
-- botActivities — Firestore: botActivities/{id}
-- Demo-cycle entries: { botId, action ('post'|'comment'|'like'|…),
-- detail (≤90 chars), status ('ok'), createdAt }.
-- Firestore write rule is FALSE (Functions-only) — see RLS_NOTES.md
-- for how that guarantee maps (it cannot be reproduced 1:1 for the
-- browser runner; the service-role writer is the equivalent).
-- Listener (admins): order by createdAt desc, limit 100.
-- =====================================================================
create table public."botActivities" (
  id          text primary key,
  "botId"     text not null default '',
  action      text not null default '',
  detail      text not null default '',
  status      text not null default 'ok',
  "createdAt" bigint not null default 0
);
create index bot_activities_created_idx on public."botActivities" ("createdAt" desc);
create index bot_activities_bot_idx on public."botActivities" ("botId", "createdAt" desc);

-- =====================================================================
-- botLogs — Firestore: botLogs/{id}
-- Entries: { botId, level ('info'|…), message, createdAt }.
-- Same Functions-only write situation as botActivities.
-- =====================================================================
create table public."botLogs" (
  id          text primary key,
  "botId"     text not null default '',
  level       text not null default 'info',
  message     text not null default '',
  "createdAt" bigint not null default 0
);
create index bot_logs_created_idx on public."botLogs" ("createdAt" desc);
create index bot_logs_bot_idx on public."botLogs" ("botId", "createdAt" desc);

-- =====================================================================
-- botRunners — Firestore: botRunners/{id} (admin read/write)
-- Two doc families share the collection:
--  * "autocycle_<windowKey>": the cross-runner window claim
--    { kind: 'live-autocycle', window, by, createdAt, status: 'claimed' }
--    — written inside a transaction today; in Postgres this becomes
--    INSERT ... ON CONFLICT (id) DO NOTHING and checking the row count
--    (see RLS_NOTES.md). The claim is the one place the migration gets
--    STRICTER for free: unique PK + atomic insert.
--  * "decisions_<botId>": persisted decision history
--    { botId, items: [{ action, reason, at }] (cap 50), updatedAt }
-- =====================================================================
create table public."botRunners" (
  id          text primary key,
  kind        text not null default '',      -- claims: 'live-autocycle'
  "window"    bigint,                        -- claims: the window key
  by          text not null default '',      -- claims: claiming admin uid
  status      text not null default '',      -- claims: 'claimed'
  "botId"     text not null default '',      -- decisions docs
  items       jsonb,                         -- decisions docs: [{action, reason, at}]
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0
);

-- =====================================================================
-- botSettings — Firestore: botSettings/{id}
-- Singleton docs: 'global' { enabled } (kill switch) and 'counters'
-- { day (Dhaka YYYY-MM-DD), counters: { botId: { postsToday,
-- commentsToday, likesToday, messagesToday, lastActionAt } },
-- updatedAt }. One table, both shapes — columns for the union, each
-- row uses its own subset, exactly like the Firestore docs.
-- =====================================================================
create table public."botSettings" (
  id          text primary key,              -- 'global' | 'counters'
  enabled     boolean,                       -- 'global' only
  day         text,                          -- 'counters' only
  counters    jsonb not null default '{}'::jsonb,  -- 'counters' only
  "updatedAt" bigint not null default 0
);

-- =====================================================================
-- botSecrets — Firestore: botSecrets/config (admin-only, both ways)
-- Holds the AI provider keys + usage. NEVER readable by non-admins —
-- this is the one table where a policy mistake leaks live API keys.
--   geminiApiKey: the original top-level Gemini field (legacy name;
--                 Gemini is currently deactivated — see plan history)
--   providers: { <providerId>: { apiKey, enabled, defaultModel }
--                | ollama: { endpoint, enabled } }
--   aiUsage:   { day (Dhaka), providers: { <providerId>:
--                { calls, errors, promptTokens, completionTokens,
--                  exhaustedUntil } } }
-- =====================================================================
create table public."botSecrets" (
  id            text primary key,            -- 'config'
  "geminiApiKey" text not null default '',
  providers     jsonb not null default '{}'::jsonb,
  "aiUsage"     jsonb not null default '{}'::jsonb,
  "updatedAt"   bigint not null default 0
);

-- =====================================================================
-- config — Firestore: config/{id}; the only doc is config/app
-- Platform settings (Pack C + Stage A): maintenanceMode,
-- registrationOpen (absent/null = open — see registration_open()),
-- platformName, defaultLanguage ('en'|'bn'), aiFallbackOrder
-- (provider id list), aiPaidApproved. Firestore docs are schemaless
-- and admins save through a merge, so any future key lands in the
-- `extra` overflow instead of needing a migration per setting.
-- Readable by every signed-in user; writable by admins only.
-- =====================================================================
create table public.config (
  id                text primary key,        -- 'app'
  "maintenanceMode" boolean not null default false,
  "registrationOpen" boolean,                -- null = open
  "platformName"    text,
  "defaultLanguage" text,
  "aiFallbackOrder" jsonb,                   -- [providerId] | null
  "aiPaidApproved"  boolean not null default false,
  extra             jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------------
-- RLS helper functions (used by the policies specified in RLS_NOTES.md)
-- These mirror the firestore.rules helpers one-for-one. They are
-- SECURITY DEFINER so they can read public.users from inside a policy
-- ON public.users without recursing through that table's own RLS;
-- they only ever expose the CALLER's own role/status, or a boolean
-- about a target bot row. `stable` + the (select auth.uid()) pattern
-- keeps them cheap under the planner.
-- ---------------------------------------------------------------------
create or replace function public.caller_user()
returns public.users
language sql stable security definer set search_path = public
as $$
  select u from public.users u where u.id = (select auth.uid())::text
$$;

create or replace function public.caller_role()
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce((select u.role from public.users u
                   where u.id = (select auth.uid())::text), 'user')
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select public.caller_role() in ('admin', 'superadmin') $$;

create or replace function public.is_superadmin()
returns boolean language sql stable security definer set search_path = public
as $$ select public.caller_role() = 'superadmin' $$;

create or replace function public.is_moderator()
returns boolean language sql stable security definer set search_path = public
as $$ select public.caller_role() in ('moderator', 'admin', 'superadmin') $$;

-- firestore.rules writerStatusOk(): the writer's own status is absent
-- or 'active'. Suspended/banned writers are refused at create time.
create or replace function public.writer_status_ok()
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce((select u.status from public.users u
                   where u.id = (select auth.uid())::text), 'active') = 'active'
$$;

-- firestore.rules isBotUser(uid): target account exists and is a bot.
create or replace function public.is_bot_user(target_id text)
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce((select u."isBot" from public.users u where u.id = target_id), false)
$$;

-- config/app.registrationOpen with the rules' exists() guard: a
-- missing row (or null flag) means registration is OPEN.
create or replace function public.registration_open()
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce((select c."registrationOpen" from public.config c where c.id = 'app'), true)
$$;


-- =====================================================================
-- Enable RLS on everything (policies: see RLS_NOTES.md — they land as
-- the follow-up policies migration; until then these tables are
-- deny-all for the anon/authenticated roles, service_role bypasses).
-- =====================================================================
alter table public.users enable row level security;
alter table public.posts enable row level security;
alter table public.stories enable row level security;
alter table public.groups enable row level security;
alter table public."groupRequests" enable row level security;
alter table public.pages enable row level security;
alter table public.reviews enable row level security;
alter table public.events enable row level security;
alter table public.conversations enable row level security;
alter table public.invites enable row level security;
alter table public.messages enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;
alter table public.notifications enable row level security;
alter table public.reports enable row level security;
alter table public."adminLogs" enable row level security;
alter table public.announcements enable row level security;
alter table public.bots enable row level security;
alter table public."botBrains" enable row level security;
alter table public."botMemories" enable row level security;
alter table public."botConversations" enable row level security;
alter table public."botActivities" enable row level security;
alter table public."botLogs" enable row level security;
alter table public."botRunners" enable row level security;
alter table public."botSettings" enable row level security;
alter table public."botSecrets" enable row level security;
alter table public.config enable row level security;

commit;
