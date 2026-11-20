// HTML generators for every route. Pure string builders: they read the shared
// dataset (api.data()) and never touch the DOM directly — main.js renders
// and binds events centrally.
import { escapeHtml, timeAgo, canViewPost, canViewGroup, canViewGroupPost, isGroupMember, searchByName, truncate, paginate, groupStoriesByAuthor, canViewStory, storyBackgroundCss, STORY_BACKGROUNDS, memoriesFor, upcomingEvents, canViewEvent, averageRating, FEELINGS, plural, mutualFriendCount, isStaff, canModerate, isAdminRole, accountStatus, canManageUser, canChangeRole, ASSIGNABLE_ROLES, platformStats, analyticsSeries, spamSuspects, reportStatus, reportCategory, reportNeedsAttention, countPostComments, botConversationSummaries, recentClientErrors, collapseDuplicateNotifications, REPORT_CATEGORIES, REPORT_OUTCOMES, typingUserIds, reactionChips, pinnedMessages, messageSnippet, chatTheme, CHAT_THEMES, MESSAGE_REACTIONS, reviewText } from './utils.js';
import { botModel } from './gemini.js';
import { cldImg } from './cloudinary.js';
import { AI_PROVIDERS, providerById, resolveAiConfig, usageTotals } from './aiProviders.js';
import { t } from './i18n.js';
import { avatarHtml, userNameHtml, postCardHtml, emptyState } from './components.js';
import { friendIdsOf, blockedIdsOf } from './store.js';
import { firebaseReady } from './firebase.js';

// Transient per-session UI state that views need but which is not app
// data (main.js flips these; a re-render reads them).
export const uiState = { memoriesDismissed: false, convInfoFor: '' };

export function usersById(d) {
  return Object.fromEntries(d.users.map((u) => [u.id, u]));
}

export function viewCtx(d, meUser) {
  const byId = usersById(d);
  const friendIds = meUser ? friendIdsOfData(d, meUser.id) : new Set();
  return {
    usersById: byId, me: meUser, friendIds,
    pagesById: Object.fromEntries((d.pages || []).map((p) => [p.id, p])),
    groupsById: Object.fromEntries((d.groups || []).map((g) => [g.id, g]))
  };
}

export function friendIdsOfData(d, uidValue) {
  const ids = new Set();
  for (const f of d.friendships) {
    if (f.status !== 'accepted') continue;
    if (f.from === uidValue) ids.add(f.to);
    if (f.to === uidValue) ids.add(f.from);
  }
  return ids;
}

export function blockedIdsOfData(d, uidValue) {
  return new Set((d.blocks || []).filter((b) => b.by === uidValue).map((b) => b.target));
}

// ------------------------------------------------------------------ AUTH
// Multicolour Google "G" (the official four-colour mark, inline SVG).
const GOOGLE_G_SVG = '<svg class="google-g" width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>';

// Password field with a show/hide eye toggle (main.js wires data-act).
function passwordFieldHtml({ name = 'password', labelKey = 'password', autocomplete = 'current-password', placeholder = '••••••••', required = true, minlength = '' }) {
  return `<label>${t(labelKey)}<span class="pw-wrap"><input name="${name}" type="password" ${required ? 'required' : ''} ${minlength ? `minlength="${minlength}"` : ''} autocomplete="${autocomplete}" placeholder="${placeholder}" /><button type="button" class="pw-eye" data-act="toggle-pw" aria-label="${t('showPassword')}" title="${t('showPassword')}">👁️</button></span></label>`;
}

export function authView(mode = 'login') {
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="logo-big">MeetBook</div>
      <p>${t('authTagline')}</p>
      <ul class="auth-feats">
        <li>📰 ${t('authFeat1')}</li>
        <li>💬 ${t('authFeat2')}</li>
        <li>🤖 ${t('authFeat3')}</li>
      </ul>
    </div>
    <div class="card auth-card">
      ${mode === 'login' ? `
      <form id="login-form" class="stack">
        <label>${t('email')}<input name="email" type="email" required autocomplete="username" placeholder="you@example.com" /></label>
        ${passwordFieldHtml({})}
        <button class="btn btn-primary btn-block" type="submit">${t('login')}</button>
        <button class="btn btn-google btn-block" type="button" data-act="google-login">${GOOGLE_G_SVG} ${t('continueWithGoogle')}</button>
        <button class="link-btn center" type="button" data-act="forgot">${t('forgotPassword')}</button>
        ${firebaseReady ? '' : `<p class="muted small center">Demo accounts (offline mode): admin@meetbook.app / admin123 · ayesha@example.com / demo123</p>`}
        <p class="muted small center">${t('newToMeetBook')} <a href="#/register">${t('register')}</a></p>
      </form>` : `
      <form id="register-form" class="stack">
        <label>${t('fullName')}<input name="name" required maxlength="60" autocomplete="name" placeholder="Your name" /></label>
        <label>${t('username')}<input name="username" required maxlength="24" autocomplete="username" placeholder="your.name" /></label>
        <label>${t('email')}<input name="email" type="email" required autocomplete="email" placeholder="you@example.com" /></label>
        ${passwordFieldHtml({ autocomplete: 'new-password', placeholder: 'At least 6 characters', minlength: '6' })}
        ${passwordFieldHtml({ name: 'confirmPassword', labelKey: 'confirmPassword', autocomplete: 'new-password', placeholder: 'At least 6 characters', minlength: '6' })}
        <label>${t('dob')}<input name="dob" type="date" /></label>
        <label>${t('gender')}
          <select name="gender">
            <option value="">—</option>
            <option value="Female">${t('genderFemale')}</option>
            <option value="Male">${t('genderMale')}</option>
            <option value="Other">${t('genderOther')}</option>
            <option value="Prefer not to say">${t('genderPreferNot')}</option>
          </select>
        </label>
        <button class="btn btn-primary btn-block" type="submit">${t('register')}</button>
        <button class="btn btn-google btn-block" type="button" data-act="google-login">${GOOGLE_G_SVG} ${t('continueWithGoogle')}</button>
        <p class="muted small center">By registering you agree to our <a href="#/terms">Terms</a> and <a href="#/privacy">Privacy Policy</a>.</p>
        <p class="muted small center">${t('alreadyHaveAccount')} <a href="#/login">${t('login')}</a></p>
      </form>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ FEED
export function feedView(d, meUser, page = 1) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  // Group posts live ONLY in their group feeds (their visibility is governed
  // by group privacy, not the post-level field), so the home feed excludes
  // them. Page posts are ordinary public posts and flow in naturally.
  const visible = d.posts
    .filter((p) => !p.groupId && canViewPost(p, { viewerId: meUser.id, authorId: p.authorId, friendIds: ctx.friendIds, blockedIds: blocked }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const pg = paginate(visible, page, 10);
  const defaultVis = meUser.settings?.defaultPostPrivacy || 'public';
  return `
  <div class="layout">
    <aside class="col-left">${leftRail(d, meUser)}</aside>
    <main class="col-main">
      ${announcementsHtml(d, meUser)}
      ${storiesRailHtml(d, meUser, ctx)}
      ${memoriesHtml(d, meUser, ctx)}
      <div class="card composer">
        <div class="row gap-sm">${avatarHtml(meUser, 40)}<span class="muted">${escapeHtml(meUser.name)}</span></div>
        <form id="composer-form" class="stack">
          <textarea name="text" rows="3" maxlength="2000" placeholder="${t('whatsOnYourMind')}"></textarea>
          <div id="composer-preview"></div>
          <input type="file" name="image" accept="image/*" hidden />
          <div class="row gap wrap">
            <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">📷 ${t('photo')}</button>
            <label class="btn btn-ghost btn-sm">📊 ${t('addPoll')}<input type="checkbox" name="hasPoll" hidden /></label>
            <select name="visibility" class="select-sm" aria-label="Post privacy">
              <option value="public" ${defaultVis === 'public' ? 'selected' : ''}>🌍 ${t('publicLabel')}</option>
              <option value="friends" ${defaultVis === 'friends' ? 'selected' : ''}>👥 ${t('friends')}</option>
              <option value="close" ${defaultVis === 'close' ? 'selected' : ''}>⭐ ${t('closeFriends')}</option>
              <option value="only-me" ${defaultVis === 'only-me' ? 'selected' : ''}>🔒 ${t('onlyMe')}</option>
            </select>
            <span class="spacer"></span>
            <button class="btn btn-primary" type="submit">${t('post')}</button>
          </div>
          <div id="poll-fields" class="stack hidden">
            <div id="poll-options-list" class="stack">
              ${[1, 2].map((i) => `<div class="row gap-sm poll-opt-row"><input name="pollOption" maxlength="60" placeholder="${t('pollOption')} ${i}" autocomplete="off" /></div>`).join('')}
            </div>
            <div class="row gap wrap">
              <button type="button" class="btn btn-ghost btn-sm" data-act="poll-add-option">＋ ${t('addOption')}</button>
              <button type="button" class="btn btn-ghost btn-sm" data-act="poll-remove">✕ ${t('removePoll')}</button>
            </div>
          </div>
          <div class="row gap wrap">
            <label class="grow">📍 ${t('checkIn')}<input name="location" maxlength="120" placeholder="e.g. Lalbagh Fort, Dhaka" autocomplete="off" /></label>
            <label>🙂 ${t('feeling')}
              <select name="feeling" class="select-sm">
                <option value="">—</option>
                ${FEELINGS.map((f) => `<option value="${f.key}">${f.emoji} ${f.labelKey ? t(f.labelKey) : f.label}</option>`).join('')}
              </select>
            </label>
          </div>
        </form>
      </div>
      <div id="feed-list">
        ${pg.items.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📰', t('noPosts'))}
      </div>
      ${pg.hasMore ? `<button class="btn btn-ghost btn-block" data-act="feed-more" data-page="${page + 1}">Load more posts</button>` : (visible.length > 10 ? '<p class="muted center small">You are all caught up 🎉</p>' : '')}
    </main>
    <aside class="col-right">${rightRail(d, meUser)}</aside>
  </div>`;
}

// ------------------------------------------------------------- ANNOUNCEMENTS
// Active platform announcements (Pack C) as dismissible banner cards
// at the top of the home feed. Dismissal is remembered per user in
// users.settings.dismissedAnnouncements (main.js writes it through
// api.updateSettings), so a dismissed banner never comes back for
// that user, on any device.
export function announcementsHtml(d, meUser) {
  const dismissed = new Set(meUser.settings?.dismissedAnnouncements || []);
  const active = (d.announcements || [])
    .filter((a) => a.active !== false && !dismissed.has(a.id))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!active.length) return '';
  return active.map((a) => `<div class="card announcement-banner">
    <div class="row gap-sm">
      <span aria-hidden="true">📣</span>
      <div class="grow"><b>${escapeHtml(a.title)}</b>
        <p class="small">${escapeHtml(a.body)}</p>
        <span class="muted small">${escapeHtml(a.createdByName || '')} · ${timeAgo(a.createdAt)}</span>
      </div>
      <button class="icon-btn" data-act="dismiss-announcement" data-id="${a.id}" aria-label="${t('announceDismiss')}" title="${t('announceDismiss')}">✕</button>
    </div>
  </div>`).join('');
}

// ------------------------------------------------------------------ MEMORIES
// "On this day" card: the viewer's own posts from the same calendar date
// in earlier years, computed client-side from already-synced posts
// (utils.memoriesFor) — no extra collection or query. Dismissible for
// the session via uiState.
export function memoriesHtml(d, meUser, ctx) {
  if (uiState.memoriesDismissed) return '';
  const memories = memoriesFor(d.posts, meUser.id);
  if (!memories.length) return '';
  return `<div class="card memory-card">
    <div class="row gap-sm">
      <h3 class="grow">🕰️ ${t('memories')} · ${t('onThisDay')}</h3>
      <button class="icon-btn" data-act="dismiss-memories" aria-label="Dismiss">✕</button>
    </div>
    ${memories.map(({ post, yearsAgo }) => `<a class="memory-item" href="#/profile/${meUser.id}">
      <span class="memory-when">${yearsAgo} ${yearsAgo === 1 ? t('yearAgo') : t('yearsAgo')}</span>
      <span class="memory-text">${escapeHtml(truncate(post.text || (post.image ? '📷 Photo' : ''), 160))}</span>
    </a>`).join('')}
  </div>`;
}

// Full Memories page (#/memories): every "on this day" post as a full
// post card, newest anniversary first. The router used to have no case
// for this route, so the link silently fell back to the home feed.
export function memoriesView(d, meUser) {
  const ctx = viewCtx(d, meUser);
  const memories = memoriesFor(d.posts, meUser.id);
  return `<div class="page narrow">
    <h2>🕰️ ${t('memories')}</h2>
    <p class="muted">${t('onThisDay')}</p>
    ${memories.length ? memories.map(({ post, yearsAgo }) => `
      <p class="memory-when-label muted"><b>${yearsAgo} ${yearsAgo === 1 ? t('yearAgo') : t('yearsAgo')}</b></p>
      ${postCardHtml(post, ctx)}`).join('') : emptyState('🕰️', t('memoriesEmpty'))}
  </div>`;
}

// ------------------------------------------------------------------ STORIES
// The rail shows one tile per author with active (≤24h) stories the viewer
// may see; expired stories never render (groupStoriesByAuthor filters by
// the 24h window). Bots never post stories, so no bot tiles appear.
export function visibleStoryGroups(d, meUser) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  const viewable = (d.stories || []).filter((s) => canViewStory(s, { viewerId: meUser.id, friendIds: ctx.friendIds, blockedIds: blocked }));
  return groupStoriesByAuthor(viewable);
}

// Flattened playback queue for the story viewer: author groups in rail
// order, each author's stories oldest-first.
export function storyQueueFor(d, meUser) {
  return visibleStoryGroups(d, meUser).flatMap((g) => g.stories);
}

export function storiesRailHtml(d, meUser, ctx) {
  const groups = visibleStoryGroups(d, meUser);
  const byId = ctx.usersById;
  const tile = (g) => {
    const author = byId[g.authorId];
    if (!author) return '';
    const latest = g.stories[g.stories.length - 1];
    const mine = g.authorId === meUser.id;
    const unviewed = !mine && g.stories.some((s) => !(s.views || []).includes(meUser.id));
    const bg = latest.image ? '' : `background:${storyBackgroundCss(latest.bg)};`;
    return `<button class="story-tile ${unviewed ? 'unviewed' : 'viewed'}" style="${bg}" data-act="view-story" data-author="${g.authorId}" aria-label="${escapeHtml(author.name)} — ${t('stories')}">
      ${latest.image ? `<img class="story-tile-img" src="${escapeHtml(cldImg(latest.image, 480))}" alt="" loading="lazy" decoding="async" />` : ''}
      <span class="story-tile-avatar">${avatarHtml(author, 34)}</span>
      <span class="story-tile-name">${escapeHtml(author.name.split(' ')[0])}</span>
    </button>`;
  };
  return `<div class="stories card">
    <button class="story-tile create" data-act="create-story" aria-label="${t('createStory')}">
      <span class="story-tile-avatar">${avatarHtml(meUser, 34)}</span>
      <span class="story-plus">➕</span>
      <span class="story-tile-name">${t('createStory')}</span>
    </button>
    ${groups.map(tile).join('')}
    ${groups.length === 0 ? `<p class="muted small story-empty">${t('noStories')}</p>` : ''}
  </div>`;
}

export function storyFormHtml() {
  return `<h3>➕ ${t('createStory')}</h3>
  <form id="story-form" class="stack">
    <label>${t('storyText')}<textarea name="text" rows="3" maxlength="300" placeholder="${t('storyTextPlaceholder')}"></textarea></label>
    <label>📷 Photo<input type="file" name="image" accept="image/*" /></label>
    <div>
      <span class="small muted">${t('storyBackground')}</span>
      <div class="bg-swatches">
        ${STORY_BACKGROUNDS.map((b, i) => `<label class="bg-swatch" style="background:${b.css}" title="${b.key}"><input type="radio" name="bg" value="${b.key}" ${i === 0 ? 'checked' : ''} /><span class="sr-only">${b.key}</span></label>`).join('')}
      </div>
    </div>
    <label>${t('privacyLabel')}
      <select name="visibility">
        <option value="public">🌍 ${t('publicLabel')}</option>
        <option value="friends">👥 ${t('friends')}</option>
      </select>
    </label>
    <p class="muted small">${t('stories')} · 24h</p>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('createStory')}</button></div>
  </form>`;
}

export function leftRail(d, meUser) {
  return `<div class="card rail">
    <a class="rail-item" href="#/profile/${meUser.id}">${avatarHtml(meUser, 36)}<span>${escapeHtml(meUser.name)}</span></a>
    <a class="rail-item" href="#/">📰 Feed</a>
    <a class="rail-item" href="#/friends">👥 ${t('friends')}</a>
    <a class="rail-item" href="#/events">📅 ${t('events')}</a>
    <a class="rail-item" href="#/memories">🕰️ ${t('memories')}</a>
    <a class="rail-item" href="#/groups">🏘️ ${t('groups')}</a>
    <a class="rail-item" href="#/pages">📄 ${t('pages')}</a>
    <a class="rail-item" href="#/messages">💬 ${t('messages')}</a>
    <a class="rail-item" href="#/saved">🔖 ${t('saved')} posts</a>
    <a class="rail-item" href="#/notifications">🔔 ${t('notifications')}</a>
    ${isStaff(meUser) ? `<a class="rail-item" href="#/admin">🛡️ ${t('admin')}</a>` : ''}${isAdminRole(meUser) ? `<a class="rail-item" href="#/admin/bots">🤖 ${t('bots')}</a>` : ''}
    <a class="rail-item" href="#/settings">⚙️ ${t('settings')}</a>
    <a class="rail-item" href="#/help">❓ ${t('help')}</a>
  </div>`;
}

export function rightRail(d, meUser) {
  const friendIds = friendIdsOfData(d, meUser.id);
  const pending = d.friendships.filter((f) => f.to === meUser.id && f.status === 'pending');
  const suggestions = suggestionsFor(d, meUser).slice(0, 4);
  const byId = usersById(d);
  return `<div class="card rail">
    ${pending.length ? `<h4>Friend requests</h4>${pending.map((f) => `<div class="row gap-sm rail-person">${avatarHtml(byId[f.from], 36)}<span class="grow">${escapeHtml(byId[f.from]?.name || '')}</span><button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${f.id}">Accept</button><button class="btn btn-ghost btn-sm" data-act="reject-request" data-id="${f.id}">✕</button></div>`).join('')}` : ''}
    <h4>People you may know</h4>
    ${suggestions.map((u) => { const mutual = mutualFriendCount(d.friendships, meUser.id, u.id); return `<div class="row gap-sm rail-person">${avatarHtml(u, 36)}<span class="grow"><a href="#/profile/${u.id}">${escapeHtml(u.name)}</a>${mutual > 0 ? `<br/><span class="muted small">${mutual} ${mutual === 1 ? t('mutualFriend') : t('mutualFriends')}</span>` : ''}</span>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : `<button class="btn btn-ghost btn-sm" data-act="send-request" data-id="${u.id}">${t('addFriend')}</button>`}</div>`; }).join('') || '<p class="muted small">No suggestions right now.</p>'}
    <h4>Online</h4>
    ${d.users.filter((u) => u.id !== meUser.id && isFreshOnline(u)).slice(0, 6).map((u) => `<a class="row gap-sm rail-person" href="#/profile/${u.id}"><span class="online-dot"></span>${escapeHtml(u.name)}${u.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}</a>`).join('') || '<p class="muted small">Nobody online.</p>'}
    <p class="muted small">${friendIds.size} friends · MeetBook</p>
  </div>`;
}

export function suggestionsFor(d, meUser) {
  const friendIds = friendIdsOfData(d, meUser.id);
  const related = new Set([...friendIds, meUser.id]);
  for (const f of d.friendships) { if (f.from === meUser.id) related.add(f.to); if (f.to === meUser.id) related.add(f.from); }
  const blocked = blockedIdsOfData(d, meUser.id);
  return d.users.filter((u) => !related.has(u.id) && !blocked.has(u.id));
}

// "Online now" for the right rail: the online flag must be set AND the
// lastSeen heartbeat fresh (within 10 minutes). Older user docs without
// lastSeen fall back to the flag alone so nobody vanishes unfairly.
const ONLINE_FRESH_MS = 10 * 60_000;
export function isFreshOnline(u, now = Date.now()) {
  if (!u?.online) return false;
  const seen = Number(u.lastSeen) || 0;
  if (!seen) return true;
  return now - seen < ONLINE_FRESH_MS;
}

// ------------------------------------------------------------------ PROFILE
export function profileView(d, meUser, userId) {
  const ctx = viewCtx(d, meUser);
  const user = ctx.usersById[userId];
  if (!user) return emptyState('🕵️', 'This profile could not be found.');
  const isMe = user.id === meUser.id;
  const friendIds = friendIdsOfData(d, user.id);
  const myFriends = friendIdsOfData(d, meUser.id);
  const rel = d.friendships.find((f) => (f.from === meUser.id && f.to === user.id) || (f.from === user.id && f.to === meUser.id));
  const following = (meUser.following || []).includes(user.id);
  const blocked = blockedIdsOfData(d, meUser.id).has(user.id);
  const posts = d.posts.filter((p) => p.authorId === user.id && !p.groupId && canViewPost(p, { viewerId: meUser.id, authorId: p.authorId, friendIds: myFriends, blockedIds: blockedIdsOfData(d, meUser.id) })).sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${user.cover ? `background-image:url('${escapeHtml(user.cover)}')` : ''}">
        ${isMe ? `<button class="btn btn-ghost btn-sm cover-edit-btn" data-act="edit-profile">📷 ${user.cover ? t('changeCoverPhoto') : t('addCoverPhoto')}</button>` : ''}
      </div>
      <div class="profile-meta">
        ${avatarHtml(user, 110)}
        <div class="grow">
          <h2>${userNameHtml(user)}${user.nickname ? ` <span class="nickname">(${escapeHtml(user.nickname)})</span>` : ''}</h2>
          <p class="muted">@${escapeHtml(user.username)} · ${friendIds.size} friends · ${(user.followers || []).length} followers · <span class="${user.online ? 'online-text' : 'muted'}">${user.online ? '● ' + t('online') : t('offline')}</span></p>
          <p>${escapeHtml(user.bio || 'No bio yet.')}</p>
          ${isMe && !user.avatar ? `<button class="link-btn small" data-act="edit-profile">📷 ${t('addProfilePhoto')}</button>` : ''}
        </div>
        <div class="row gap wrap">
          ${isMe ? `<button class="btn btn-primary" data-act="edit-profile">✏️ ${t('editProfile')}</button>` : `
            ${blocked ? `<button class="btn btn-ghost" data-act="block" data-id="${user.id}">Unblock</button>` : `
              ${rel?.status === 'accepted' ? `<button class="btn btn-ghost" data-act="remove-friend" data-id="${rel.id}">✓ Friends</button>` : rel?.status === 'pending' && rel.from === meUser.id ? `<button class="btn btn-ghost" data-act="cancel-request" data-id="${rel.id}" title="${t('tapToCancel')}">✓ ${t('requestSent')}</button>` : rel?.status === 'pending' ? `<button class="btn btn-primary" data-act="accept-request" data-id="${rel.id}">Accept request</button>` : (!user.isBot ? `<button class="btn btn-primary" data-act="send-request" data-id="${user.id}">${t('addFriend')}</button>` : '')}
              <button class="btn ${following ? 'btn-ghost' : 'btn-primary'}" data-act="follow" data-id="${user.id}">${following ? t('following') : t('follow')}</button>
              <button class="btn btn-ghost" data-act="message-user" data-id="${user.id}">💬 Message</button>
              <button class="btn btn-ghost" data-act="block" data-id="${user.id}">Block</button>
              <button class="btn btn-ghost" data-act="report-user" data-id="${user.id}">🚩 ${t('report')}</button>`}
          `}
        </div>
      </div>
    </div>
    ${(() => {
      const intro = introCardHtml(user, isMe);
      // Photos strip: this user's photo posts (already visibility-filtered
      // into `posts` above), newest first, up to 9 thumbnails. The strip
      // ALWAYS renders (Audit fix #7) — thumbnails when photo posts
      // exist, a clean empty state otherwise — exactly like the
      // Friends strip below, so the profile layout never depends on
      // whether the account happens to have photo posts yet.
      const photoPosts = posts.filter((p) => p.image).slice(0, 9);
      const photosStrip = `<div class="card strip-card">
        <h3>${t('photos')}</h3>
        ${photoPosts.length
          ? `<div class="photos-grid">${photoPosts.map((p) => `<img class="photos-thumb" src="${escapeHtml(cldImg(p.image, 480))}" alt="${escapeHtml(truncate(p.text || 'Photo', 60))}" loading="lazy" decoding="async" />`).join('')}</div>`
          : `<p class="muted small">${t('noPhotosYet')}</p>`}
      </div>`;
      // Friends strip: count + up to 9 friend avatars linking to profiles.
      const friendUsers = [...friendIds].map((id) => ctx.usersById[id]).filter(Boolean).slice(0, 9);
      const friendsStrip = `<div class="card strip-card">
        <h3>${t('friends')} (${friendIds.size})</h3>
        ${friendUsers.length
          ? `<div class="friends-strip">${friendUsers.map((u) => `<a class="friend-tile" href="#/profile/${u.id}">${avatarHtml(u, 52)}<span>${escapeHtml(u.name.split(' ')[0])}</span></a>`).join('')}</div>`
          : `<p class="muted small">${t('noFriendsYet')}</p>`}
      </div>`;
      const sideBits = intro + photosStrip + friendsStrip;
      const postsHtml = `<div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📝', 'No visible posts yet.')}
    </div>`;
      return sideBits
        ? `<div class="profile-cols"><aside class="profile-side">${sideBits}</aside>${postsHtml}</div>`
        : postsHtml;
    })()}
  </div>`;
}

// Facebook-style Intro card: only the About fields the user actually
// filled in, one icon row each. Website values are linked (https:// is
// assumed when no scheme is present).
export function introCardHtml(user, isMe = false) {
  const items = [];
  if (user.work) items.push(`<div class="intro-row"><span class="intro-icon">💼</span><span>${t('worksAt')} <b>${escapeHtml(user.work)}</b></span></div>`);
  if (user.education) items.push(`<div class="intro-row"><span class="intro-icon">🎓</span><span>${t('studiedAt')} <b>${escapeHtml(user.education)}</b></span></div>`);
  if (user.currentCity) items.push(`<div class="intro-row"><span class="intro-icon">📍</span><span>${t('livesIn')} <b>${escapeHtml(user.currentCity)}</b></span></div>`);
  if (user.hometown) items.push(`<div class="intro-row"><span class="intro-icon">🏠</span><span>${t('fromPlace')} <b>${escapeHtml(user.hometown)}</b></span></div>`);
  if (user.relationship) items.push(`<div class="intro-row"><span class="intro-icon">❤️</span><span>${escapeHtml(user.relationship)}</span></div>`);
  if (user.dob) {
    const dobDate = new Date(`${user.dob}T00:00:00`);
    const dobText = Number.isNaN(dobDate.getTime()) ? String(user.dob) : dobDate.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    items.push(`<div class="intro-row"><span class="intro-icon">🎂</span><span>${t('birthday')}: <b>${escapeHtml(dobText)}</b></span></div>`);
  }
  if (user.gender) items.push(`<div class="intro-row"><span class="intro-icon">🧑</span><span>${t('gender')}: <b>${escapeHtml(user.gender)}</b></span></div>`);
  if (user.website) {
    const href = /^https?:\/\//i.test(user.website) ? user.website : `https://${user.website}`;
    items.push(`<div class="intro-row"><span class="intro-icon">🔗</span><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(user.website)}</a></div>`);
  }
  if (!items.length && !isMe) return '';
  return `<div class="card intro-card">
    <h3>${t('intro')}</h3>
    ${items.join('') || `<p class="muted small">Add your work, education, city and more from Edit profile.</p>`}
  </div>`;
}

// ------------------------------------------------------------------ FRIENDS
export function friendsView(d, meUser) {
  const byId = usersById(d);
  const friendIds = friendIdsOfData(d, meUser.id);
  const incoming = d.friendships.filter((f) => f.to === meUser.id && f.status === 'pending');
  const outgoing = d.friendships.filter((f) => f.from === meUser.id && f.status === 'pending');
  const suggestions = suggestionsFor(d, meUser);
  const mutualLine = (u) => {
    if (!u) return '';
    const n = mutualFriendCount(d.friendships, meUser.id, u.id);
    return n > 0 ? `<span class="muted small">${n} ${n === 1 ? t('mutualFriend') : t('mutualFriends')}</span>` : '';
  };
  const person = (u, actions, extra = '') => `<div class="card person-card">${avatarHtml(u, 56)}<a href="#/profile/${u.id}"><b>${escapeHtml(u.name)}</b></a><span class="muted small">@${escapeHtml(u.username)}</span>${extra}${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}<div class="row gap wrap center">${actions}</div></div>`;
  return `<div class="page">
    <h2>👥 ${t('friends')}</h2>
    <h3>${t('requestsReceived')}</h3>
    ${incoming.length ? `<div class="grid-people">${incoming.map((f) => person(byId[f.from], `<button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${f.id}">Accept</button><button class="btn btn-ghost btn-sm" data-act="reject-request" data-id="${f.id}">Reject</button>`, mutualLine(byId[f.from]))).join('')}</div>` : `<p class="muted">${t('noRequestsReceived')}</p>`}
    <h3>${t('requestsSent')}</h3>
    ${outgoing.length ? `<div class="grid-people">${outgoing.map((f) => person(byId[f.to], `<button class="btn btn-ghost btn-sm" data-act="cancel-request" data-id="${f.id}">${t('cancelRequest')}</button>`)).join('')}</div>` : `<p class="muted">${t('noRequestsSent')}</p>`}
    <h3>${t('yourFriends')} (${friendIds.size})</h3>
    <div class="grid-people">${[...friendIds].map((id) => { const rel = d.friendships.find((f) => f.status === 'accepted' && ((f.from === meUser.id && f.to === id) || (f.to === meUser.id && f.from === id))); const isClose = (meUser.closeFriends || []).includes(id); return person(byId[id], `<button class="btn ${isClose ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="toggle-close-friend" data-id="${id}" title="${t('closeFriends')}">${isClose ? '⭐' : '☆'} ${t('closeFriends')}</button><button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${id}">Message</button><button class="btn btn-ghost btn-sm" data-act="remove-friend" data-id="${rel?.id}">Remove</button>`); }).join('') || '<p class="muted">No friends yet — send a request below.</p>'}</div>
    <h3>${t('suggestedForYou')}</h3>
    <div class="grid-people">${suggestions.map((u) => person(u, u.isBot ? `<button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${u.id}">Chat with bot</button>` : `<button class="btn btn-primary btn-sm" data-act="send-request" data-id="${u.id}">${t('addFriend')}</button>`, mutualLine(u))).join('') || '<p class="muted">No suggestions.</p>'}</div>
  </div>`;
}

// ------------------------------------------------------------------ GROUPS
export function groupsView(d, meUser, queryText = '') {
  // Private groups are DISCOVERABLE by name/description (Facebook-style)
  // so people can request to join; their posts and member list stay
  // member-only (groupView + the group read rules enforce that).
  const visible = (d.groups || []).filter((g) => canViewGroup(g, meUser.id) || g.privacy === 'private');
  const mine = searchByName(visible.filter((g) => isGroupMember(g, meUser.id)), queryText);
  const discover = searchByName(visible.filter((g) => !isGroupMember(g, meUser.id)), queryText);
  const card = (g) => {
    const pendingReq = (d.groupRequests || []).some((r) => r.groupId === g.id && r.userId === meUser.id && r.status === 'pending');
    return `<div class="card person-card">
    ${avatarHtml({ name: g.name, username: g.name, avatar: g.cover }, 56)}
    <a href="#/group/${g.id}"><b>${escapeHtml(g.name)}</b></a>
    <span class="muted small">${g.privacy === 'private' ? '🔒 ' + t('privateLabel') : '🌍 ' + t('publicLabel')} · ${plural((g.members || []).length, t('member'), t('members'))}</span>
    <span class="muted small">${escapeHtml(truncate(g.description || '', 90))}</span>
    <div class="row gap wrap center">
      ${isGroupMember(g, meUser.id) ? `<span class="badge badge-ok">${t('joined')}</span>` : pendingReq ? `<span class="badge badge-warn">${t('requestPending')}</span>` : `<button class="btn btn-primary btn-sm" data-act="toggle-group-join" data-id="${g.id}">${g.privacy === 'private' ? t('requestToJoin') : t('joinGroup')}</button>`}
      <a class="btn btn-ghost btn-sm" href="#/group/${g.id}">View</a>
    </div>
  </div>`;
  };
  return `<div class="page">
    <div class="row"><h2 class="grow">🏘️ ${t('groups')}</h2><button class="btn btn-primary" data-act="create-group">+ ${t('createGroup')}</button></div>
    <form id="groups-search-form" class="row gap">
      <input name="q" class="grow" placeholder="${t('searchGroups')}" value="${escapeHtml(queryText || '')}" autocomplete="off" />
      <button class="btn btn-ghost" type="submit">${t('search')}</button>
    </form>
    <h3>${t('yourGroups')} (${mine.length})</h3>
    <div class="grid-people">${mine.map(card).join('') || `<p class="muted">${t('noGroups')}</p>`}</div>
    <h3>${t('discoverGroups')}</h3>
    <div class="grid-people">${discover.map(card).join('') || `<p class="muted">${t('noGroups')}</p>`}</div>
  </div>`;
}

export function groupView(d, meUser, groupId) {
  const group = (d.groups || []).find((g) => g.id === groupId);
  if (!group) return emptyState('🏘️', 'This group could not be found.');
  if (!canViewGroup(group, meUser.id)) {
    // Private group, not a member: show only the public metadata and the
    // join-request action — no posts, no member list.
    const pending = (d.groupRequests || []).find((r) => r.groupId === group.id && r.userId === meUser.id && r.status === 'pending');
    return `<div class="profile-wrap"><div class="card profile-head">
      <div class="cover"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: group.name, username: group.name, avatar: '' }, 110)}
        <div class="grow">
          <h2>${escapeHtml(group.name)}</h2>
          <p class="muted">🔒 ${t('privateLabel')} · ${plural((group.members || []).length, t('member'), t('members'))}</p>
          <p>${escapeHtml(group.description || '')}</p>
        </div>
        <div class="row gap wrap">
          ${pending ? `<span class="badge badge-warn">${t('requestPending')}</span><button class="btn btn-ghost" data-act="toggle-group-join" data-id="${group.id}">${t('withdrawRequest')}</button>`
            : `<button class="btn btn-primary" data-act="toggle-group-join" data-id="${group.id}">${t('requestToJoin')}</button>`}
        </div>
      </div>
    </div></div>`;
  }
  const ctx = viewCtx(d, meUser);
  ctx.showGroupContext = false; // already inside the group — no context note
  const byId = ctx.usersById;
  const member = isGroupMember(group, meUser.id);
  const isCreator = group.createdBy === meUser.id;
  const blocked = blockedIdsOfData(d, meUser.id);
  const myPending = (d.groupRequests || []).find((r) => r.groupId === group.id && r.userId === meUser.id && r.status === 'pending');
  const pendingRequests = isCreator ? (d.groupRequests || []).filter((r) => r.groupId === group.id && r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt) : [];
  // Announcements (pinned posts) lead the group feed, newest first within
  // each tier.
  const posts = d.posts
    .filter((p) => p.groupId === group.id && canViewGroupPost(p, group, meUser.id, blocked))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt);
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${group.cover ? `background-image:url('${escapeHtml(group.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: group.name, username: group.name, avatar: '' }, 110)}
        <div class="grow">
          <h2>${escapeHtml(group.name)}</h2>
          <p class="muted">${group.privacy === 'private' ? '🔒 ' + t('privateLabel') : '🌍 ' + t('publicLabel')} · ${plural((group.members || []).length, t('member'), t('members'))} · created by ${escapeHtml(byId[group.createdBy]?.name || '')}</p>
          <p class="muted small">🏘️ ${t('aboutThisGroup')}: ${group.privacy === 'private' ? '🔒 ' + t('privateLabel') : '🌍 ' + t('publicLabel')} · ${t('createdOn')} ${new Date(group.createdAt || Date.now()).toLocaleDateString()} · ${plural((group.members || []).length, t('member'), t('members'))}</p>
          <p>${escapeHtml(group.description || '')}</p>
        </div>
        <div class="row gap wrap">
          ${isCreator ? `<button class="btn btn-primary" data-act="edit-group" data-id="${group.id}">✏️ ${t('edit')}</button><button class="btn btn-danger" data-act="delete-group" data-id="${group.id}">${t('delete')} group</button>`
            : member ? `<button class="btn btn-ghost" data-act="toggle-group-join" data-id="${group.id}">${t('leaveGroup')}</button>`
            : myPending ? `<span class="badge badge-warn">${t('requestPending')}</span><button class="btn btn-ghost" data-act="toggle-group-join" data-id="${group.id}">${t('withdrawRequest')}</button>`
            : `<button class="btn btn-primary" data-act="toggle-group-join" data-id="${group.id}">${group.privacy === 'private' ? t('requestToJoin') : t('joinGroup')}</button>`}
        </div>
      </div>
    </div>
    ${isCreator && pendingRequests.length ? `
    <div class="card stack">
      <h3>📥 ${t('joinRequests')} (${pendingRequests.length})</h3>
      ${pendingRequests.map((r) => { const u = byId[r.userId]; return u ? `<div class="row gap-sm">${avatarHtml(u, 36)}<a class="grow" href="#/profile/${u.id}">${escapeHtml(u.name)}</a><button class="btn btn-primary btn-sm" data-act="approve-group-request" data-id="${r.id}">${t('approve')}</button><button class="btn btn-ghost btn-sm" data-act="reject-group-request" data-id="${r.id}">${t('reject')}</button></div>` : ''; }).join('')}
    </div>` : ''}
    ${member ? `
    <div class="card composer">
      <div class="row gap-sm">${avatarHtml(meUser, 40)}<span class="muted">${escapeHtml(meUser.name)}</span></div>
      <form id="group-composer-form" data-group="${group.id}" class="stack">
        <textarea name="text" rows="3" maxlength="2000" placeholder="${t('postToGroup')}"></textarea>
        <input type="file" name="image" accept="image/*" hidden />
        <div class="row gap wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">📷 ${t('photo')}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${t('post')}</button>
        </div>
      </form>
    </div>` : `<div class="card"><p class="muted">${t('joinToPost')}</p></div>`}
    <div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📝', t('noPosts'))}
    </div>
    <div class="card stack">
      <h3>${t('members')} (${(group.members || []).length})</h3>
      ${(group.members || []).map((id) => {
        const u = byId[id];
        if (!u) return '';
        return `<div class="row gap-sm">${avatarHtml(u, 36)}<a class="grow" href="#/profile/${u.id}">${escapeHtml(u.name)}</a>${id === group.createdBy ? ` <span class="badge badge-admin">${t('roleAdmin')}</span>` : ''}${u.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}${isCreator && id !== group.createdBy ? `<button class="btn btn-ghost btn-sm" data-act="remove-member" data-group="${group.id}" data-id="${id}">Remove</button>` : ''}</div>`;
      }).join('')}
    </div>
  </div>`;
}

export function groupFormHtml(group = null) {
  return `<h3>${group ? `${t('edit')} group` : t('createGroup')}</h3>
  <form id="group-form" data-id="${group?.id || ''}" class="stack">
    <label>${t('groupName')}<input name="name" required maxlength="80" value="${escapeHtml(group?.name || '')}" /></label>
    <label>${t('description')}<textarea name="description" rows="3" maxlength="500">${escapeHtml(group?.description || '')}</textarea></label>
    <label>${t('privacyLabel')}
      <select name="privacy">
        <option value="public" ${group?.privacy !== 'private' ? 'selected' : ''}>🌍 ${t('publicLabel')}</option>
        <option value="private" ${group?.privacy === 'private' ? 'selected' : ''}>🔒 ${t('privateLabel')}</option>
      </select>
    </label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${group ? 'Save group' : t('createGroup')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ PAGES
export function pagesView(d, meUser, queryText = '') {
  const all = d.pages || [];
  const mine = searchByName(all.filter((p) => p.ownerId === meUser.id || (p.followers || []).includes(meUser.id)), queryText);
  const discover = searchByName(all.filter((p) => p.ownerId !== meUser.id && !(p.followers || []).includes(meUser.id)), queryText);
  const card = (p) => `<div class="card person-card">
    ${avatarHtml({ name: p.name, username: p.name, avatar: p.avatar }, 56)}
    <a href="#/page/${p.id}"><b>${escapeHtml(p.name)}</b></a>
    <span class="badge">${escapeHtml(p.category || t('pageLabel'))}</span>
    <span class="muted small">${plural((p.followers || []).length, t('follower'), t('followers'))}</span>
    <span class="muted small">${escapeHtml(truncate(p.about || '', 90))}</span>
    <div class="row gap wrap center">
      ${p.ownerId === meUser.id ? `<span class="badge badge-ok">Your page</span>` : (p.followers || []).includes(meUser.id) ? `<button class="btn btn-ghost btn-sm" data-act="follow-page" data-id="${p.id}">${t('following')}</button>` : `<button class="btn btn-primary btn-sm" data-act="follow-page" data-id="${p.id}">${t('follow')}</button>`}
      <a class="btn btn-ghost btn-sm" href="#/page/${p.id}">View</a>
    </div>
  </div>`;
  return `<div class="page">
    <div class="row"><h2 class="grow">📄 ${t('pages')}</h2><button class="btn btn-primary" data-act="create-page">+ ${t('createPage')}</button></div>
    <form id="pages-search-form" class="row gap">
      <input name="q" class="grow" placeholder="${t('searchPages')}" value="${escapeHtml(queryText || '')}" autocomplete="off" />
      <button class="btn btn-ghost" type="submit">${t('search')}</button>
    </form>
    <h3>${t('yourPages')} (${mine.length})</h3>
    <div class="grid-people">${mine.map(card).join('') || `<p class="muted">${t('noPages')}</p>`}</div>
    <h3>${t('discoverPages')}</h3>
    <div class="grid-people">${discover.map(card).join('') || `<p class="muted">${t('noPages')}</p>`}</div>
  </div>`;
}

export function pageView(d, meUser, pageId) {
  const page = (d.pages || []).find((p) => p.id === pageId);
  if (!page) return emptyState('📄', 'This page could not be found.');
  const ctx = viewCtx(d, meUser);
  const isOwner = page.ownerId === meUser.id;
  const following = (page.followers || []).includes(meUser.id);
  const posts = d.posts.filter((p) => p.pageId === page.id).sort((a, b) => b.createdAt - a.createdAt);
  const pageReviews = (d.reviews || []).filter((r) => r.pageId === page.id).sort((a, b) => b.createdAt - a.createdAt);
  const ratingSummary = averageRating(pageReviews);
  const myReview = pageReviews.find((r) => r.authorId === meUser.id);
  const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${page.cover ? `background-image:url('${escapeHtml(page.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: page.name, username: page.name, avatar: page.avatar }, 110)}
        <div class="grow">
          <h2>${escapeHtml(page.name)}</h2>
          <p class="muted">${escapeHtml(page.category || '')} · ${plural((page.followers || []).length, t('follower'), t('followers'))} · by ${escapeHtml(ctx.usersById[page.ownerId]?.name || '')}</p>
          <p>${escapeHtml(page.about || '')}</p>
        </div>
        <div class="row gap wrap">
          ${isOwner ? `<button class="btn btn-primary" data-act="edit-page" data-id="${page.id}">✏️ ${t('edit')}</button><button class="btn btn-danger" data-act="delete-page" data-id="${page.id}">${t('delete')} page</button>`
            : `<button class="btn ${following ? 'btn-ghost' : 'btn-primary'}" data-act="follow-page" data-id="${page.id}">${following ? t('following') : t('follow')}</button>`}
        </div>
      </div>
    </div>
    ${isOwner ? `
    <div class="card composer">
      <div class="row gap-sm">${avatarHtml({ name: page.name, username: page.name, avatar: page.avatar }, 40)}<span class="muted">${escapeHtml(page.name)}</span></div>
      <form id="page-composer-form" data-page="${page.id}" class="stack">
        <textarea name="text" rows="3" maxlength="2000" placeholder="${t('postAsPage')}"></textarea>
        <input type="file" name="image" accept="image/*" hidden />
        <div class="row gap wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">📷 ${t('photo')}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${t('post')}</button>
        </div>
      </form>
    </div>` : ''}
    <div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('📝', t('noPosts'))}
    </div>
    <div class="card stack">
      <h3>⭐ ${t('reviews')} ${ratingSummary.count ? `· <span class="stars">${stars(ratingSummary.average)}</span> ${ratingSummary.average} (${ratingSummary.count})` : ''}</h3>
      ${pageReviews.map((r) => { const a = ctx.usersById[r.authorId]; return `<div class="row gap-sm review-item">${avatarHtml(a, 36)}<div class="grow"><b>${escapeHtml(a?.name || '')}</b> <span class="stars">${stars(r.rating)}</span> <span class="muted small">· ${timeAgo(r.createdAt)}</span>${reviewText(r) ? `<br/>${escapeHtml(reviewText(r))}` : ''}</div>${r.authorId === meUser.id ? `<button class="btn btn-ghost btn-sm" data-act="delete-review" data-id="${r.id}">🗑️</button>` : ''}</div>`; }).join('') || `<p class="muted">${t('noReviews')}</p>`}
      ${isOwner ? '' : `
      <form id="review-form" data-page="${page.id}" class="stack">
        <h4>${myReview ? t('yourReview') : t('writeReview')}</h4>
        <div class="star-picker" role="radiogroup" aria-label="${t('rating')}">
          ${[1, 2, 3, 4, 5].map((n) => `<label class="star-option"><input type="radio" name="rating" value="${n}" ${Number(myReview?.rating || 0) === n ? 'checked' : ''} required /><span>${n <= Number(myReview?.rating || 0) ? '★' : '☆'}</span></label>`).join('')}
        </div>
        <textarea name="text" rows="2" maxlength="500" placeholder="${t('writeReview')}…">${escapeHtml(myReview?.text || '')}</textarea>
        <div><button class="btn btn-primary btn-sm" type="submit">${myReview ? 'Update review' : t('writeReview')}</button></div>
      </form>`}
    </div>
  </div>`;
}

const PAGE_CATEGORIES = ['Community', 'Business', 'Food & Drink', 'Technology', 'Entertainment', 'Education', 'Health', 'Arts', 'Sports', 'Other'];

export function pageFormHtml(page = null) {
  return `<h3>${page ? `${t('edit')} page` : t('createPage')}</h3>
  <form id="page-form" data-id="${page?.id || ''}" class="stack">
    <label>Page name<input name="name" required maxlength="80" value="${escapeHtml(page?.name || '')}" /></label>
    <label>${t('category')}<input name="category" list="page-categories" maxlength="60" value="${escapeHtml(page?.category || '')}" placeholder="Community" /></label>
    <datalist id="page-categories">${PAGE_CATEGORIES.map((c) => `<option value="${c}"></option>`).join('')}</datalist>
    <label>${t('about')}<textarea name="about" rows="3" maxlength="500">${escapeHtml(page?.about || '')}</textarea></label>
    <label>Profile picture<input type="file" name="avatar" accept="image/*" /></label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${page ? 'Save page' : t('createPage')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ EVENTS
function eventDateBlock(dateTime) {
  const d = new Date(dateTime || 0);
  const day = d.getDate();
  const mon = d.toLocaleDateString(undefined, { month: 'short' });
  return `<div class="event-date"><span class="event-day">${day}</span><span class="event-mon">${escapeHtml(mon)}</span></div>`;
}

function eventCardHtml(d, meUser, e, ctx) {
  const byId = ctx.usersById;
  const when = new Date(e.dateTime || 0).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const going = (e.going || []).includes(meUser.id);
  const interested = (e.interested || []).includes(meUser.id);
  return `<div class="card event-card">
    <div class="row gap">
      ${eventDateBlock(e.dateTime)}
      <div class="grow">
        <a href="#/event/${e.id}"><b>${escapeHtml(e.title)}</b></a>
        <div class="muted small">🕒 ${escapeHtml(when)}${e.location ? ` · 📍 ${escapeHtml(e.location)}` : ''}</div>
        <div class="muted small">${e.visibility === 'friends' ? '👥 ' + t('friends') : '🌍 ' + t('publicLabel')} · ${plural((e.going || []).length, t('going'), t('going'))} · ${plural((e.interested || []).length, t('interested'), t('interested'))} · by ${escapeHtml(byId[e.createdBy]?.name || '')}</div>
      </div>
    </div>
    <div class="row gap wrap">
      <button class="btn ${going ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="rsvp" data-kind="going" data-id="${e.id}">${going ? '✓ ' : ''}${t('going')}</button>
      <button class="btn ${interested ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="rsvp" data-kind="interested" data-id="${e.id}">⭐ ${t('interested')}</button>
      <a class="btn btn-ghost btn-sm" href="#/event/${e.id}">Details</a>
    </div>
  </div>`;
}

export function eventsView(d, meUser) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  const visible = upcomingEvents((d.events || []).filter((e) => canViewEvent(e, { viewerId: meUser.id, friendIds: ctx.friendIds, blockedIds: blocked })));
  return `<div class="page">
    <div class="row"><h2 class="grow">📅 ${t('events')}</h2><button class="btn btn-primary" data-act="create-event">+ ${t('createEvent')}</button></div>
    <h3>${t('upcomingEvents')} (${visible.length})</h3>
    ${visible.map((e) => eventCardHtml(d, meUser, e, ctx)).join('') || emptyState('📅', t('noEvents'))}
  </div>`;
}

export function eventView(d, meUser, eventId) {
  const e = (d.events || []).find((x) => x.id === eventId);
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  if (!e || !canViewEvent(e, { viewerId: meUser.id, friendIds: ctx.friendIds, blockedIds: blocked })) return emptyState('📅', 'This event could not be found.');
  const byId = ctx.usersById;
  const isCreator = e.createdBy === meUser.id;
  const going = (e.going || []).includes(meUser.id);
  const interested = (e.interested || []).includes(meUser.id);
  const when = new Date(e.dateTime || 0).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const personList = (ids) => (ids || []).map((id) => byId[id] ? `<div class="row gap-sm">${avatarHtml(byId[id], 32)}<a href="#/profile/${id}">${escapeHtml(byId[id].name)}</a></div>` : '').join('') || '<p class="muted small">—</p>';
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${e.cover ? `background-image:url('${escapeHtml(e.cover)}')` : ''}"></div>
      <div class="profile-meta">
        ${eventDateBlock(e.dateTime)}
        <div class="grow">
          <h2>${escapeHtml(e.title)}</h2>
          <p class="muted">🕒 ${escapeHtml(when)}${e.location ? `<br/>📍 ${escapeHtml(e.location)}` : ''}</p>
          <p class="muted small">${e.visibility === 'friends' ? '👥 ' + t('friends') : '🌍 ' + t('publicLabel')}</p>
          ${byId[e.createdBy] ? `<div class="row gap-sm host-row">${avatarHtml(byId[e.createdBy], 32)}<span>${t('hostedBy')} <a href="#/profile/${e.createdBy}"><b>${escapeHtml(byId[e.createdBy].name)}</b></a></span></div>` : ''}
        </div>
        <div class="row gap wrap">
          ${isCreator ? `<button class="btn btn-danger" data-act="delete-event" data-id="${e.id}">${t('delete')} event</button>` : ''}
        </div>
      </div>
    </div>
    <div class="card stack">
      <div class="row gap wrap">
        <button class="btn ${going ? 'btn-primary' : 'btn-ghost'}" data-act="rsvp" data-kind="going" data-id="${e.id}">${going ? '✓ ' : ''}${t('going')} (${(e.going || []).length})</button>
        <button class="btn ${interested ? 'btn-primary' : 'btn-ghost'}" data-act="rsvp" data-kind="interested" data-id="${e.id}">⭐ ${t('interested')} (${(e.interested || []).length})</button>
      </div>
      ${e.description ? `<p>${escapeHtml(e.description)}</p>` : ''}
    </div>
    <div class="card stack">
      <h3>${t('attendees')}</h3>
      <h4>${t('going')} (${(e.going || []).length})</h4>
      ${personList(e.going)}
      <h4>${t('interested')} (${(e.interested || []).length})</h4>
      ${personList(e.interested)}
    </div>
  </div>`;
}

export function eventFormHtml() {
  // datetime-local needs a value in local time; leave empty and let the
  // browser picker fill it (required).
  return `<h3>📅 ${t('createEvent')}</h3>
  <form id="event-form" class="stack">
    <label>${t('eventTitle')}<input name="title" required maxlength="120" /></label>
    <label>${t('description')}<textarea name="description" rows="3" maxlength="1000"></textarea></label>
    <label>${t('eventDate')}<input name="dateTime" type="datetime-local" required /></label>
    <label>${t('eventLocation')}<input name="location" maxlength="120" placeholder="e.g. TSC, University of Dhaka" /></label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <label>${t('privacyLabel')}
      <select name="visibility">
        <option value="public">🌍 ${t('publicLabel')}</option>
        <option value="friends">👥 ${t('friends')}</option>
      </select>
    </label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('createEvent')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ MESSAGES
export function messagesView(d, meUser, activeConvId = '') {
  const byId = usersById(d);
  const myConvs = d.conversations.filter((c) => c.participants.includes(meUser.id))
    .map((c) => {
      const isGroup = Boolean(c.isGroup);
      const otherId = c.participants.find((p) => p !== meUser.id);
      const msgs = d.messages.filter((m) => m.conversationId === c.id).sort((a, b) => a.createdAt - b.createdAt);
      const last = msgs[msgs.length - 1];
      const unread = msgs.filter((m) => m.senderId !== meUser.id && !(m.readBy || []).includes(meUser.id)).length;
      const title = isGroup ? (c.title || t('groupChat')) : (byId[otherId]?.name || 'Unknown');
      const avatarUser = isGroup ? { name: title, username: title, avatar: '' } : byId[otherId];
      let preview = 'Say hello';
      if (last) preview = last.audio && !last.text ? `🎤 ${t('voiceMessage')}` : (last.text || (last.image ? '📷 Photo' : 'Say hello'));
      if (isGroup && last && last.senderId !== meUser.id) preview = `${(byId[last.senderId]?.name || '').split(' ')[0]}: ${preview}`;
      return { conv: c, isGroup, other: byId[otherId], title, avatarUser, searchText: title.toLowerCase(), last, unread, msgs, preview };
    })
    .sort((a, b) => (b.last?.createdAt || b.conv.createdAt) - (a.last?.createdAt || a.conv.createdAt));
  const active = myConvs.find((x) => x.conv.id === activeConvId) || myConvs[0];
  return `<div class="messenger card ${activeConvId ? 'has-open' : ''}">
    <div class="conv-list">
      <div class="row gap-sm"><h3 class="grow">💬 ${t('messages')}</h3><button class="btn btn-primary btn-sm" data-act="create-group-chat">👥 ${t('newGroupChat')}</button></div>
      <input id="conv-search" class="conv-search" type="search" placeholder="${t('searchConversations')}" autocomplete="off" aria-label="${t('searchConversations')}" />
      ${myConvs.map((x) => `<button class="conv-item ${active?.conv.id === x.conv.id ? 'active' : ''}" data-act="open-conv" data-id="${x.conv.id}" data-search="${escapeHtml(x.searchText)}">
        ${avatarHtml(x.avatarUser, 44)}<span class="grow left conv-item-text"><b class="conv-title">${x.isGroup ? '👥 ' : ''}${escapeHtml(x.title)}</b> ${!x.isGroup && x.other?.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}<span class="conv-preview muted small">${escapeHtml(x.preview)}</span></span>
        ${x.unread ? `<span class="unread-badge">${x.unread}</span>` : ''}
      </button>`).join('') || `<p class="muted small">${t('noMessages')}</p>
      <div class="stack"><h4>Start a chat</h4>${d.users.filter((u) => u.id !== meUser.id).slice(0, 6).map((u) => `<button class="conv-item" data-act="message-user" data-id="${u.id}">${avatarHtml(u, 36)}<span>${escapeHtml(u.name)}</span>${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}</button>`).join('')}</div>`}
    </div>
    <div class="conv-thread">
      ${active ? `
      ${(() => { const theme = chatTheme(active.conv.theme); const pinned = pinnedMessages(active.msgs); const latestPinned = pinned[0]; return `
      <header class="thread-head"><a class="thread-back" href="#/messages" aria-label="Back to conversations">←</a>${avatarHtml(active.avatarUser, 40)}<div><b>${active.isGroup ? '👥 ' : ''}${escapeHtml(active.title)}</b><br/><span class="muted small">${active.isGroup ? `${active.conv.participants.length} ${t('members')}` : `${active.other?.online ? t('online') : t('offline')}${active.other?.isBot ? ' · AI Bot' : ''}`}</span></div>
      <span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-act="conv-info" title="${t('conversationDetails')}" aria-label="${t('conversationDetails')}">ℹ️</button>${active.isGroup ? '' : `<button class="btn btn-ghost btn-sm" data-act="report-user" data-id="${active.other?.id}">🚩</button>`}</header>
      ${latestPinned ? `<button type="button" class="pinned-bar" data-act="jump-message" data-id="${latestPinned.id}"><span class="pinned-bar-label">📌 ${t('pinnedMessage')}</span><span class="pinned-bar-text">${escapeHtml(messageSnippet(latestPinned, 90))}</span></button>` : ''}
      <div id="conv-info" class="conv-info${uiState.convInfoFor === active.conv.id ? '' : ' hidden'}">
        <div class="conv-info-section"><h4>🎨 ${t('chatTheme')}</h4>
          <div class="theme-swatches">${CHAT_THEMES.map((th) => `<button type="button" class="theme-swatch ${theme.id === th.id ? 'active' : ''}" data-act="set-theme" data-conv="${active.conv.id}" data-theme="${th.id}" title="${t(`theme_${th.id}`)}" aria-label="${t(`theme_${th.id}`)}" style="${th.gradient ? `background:${th.gradient};` : ''}">${th.id === 'default' ? '∅' : ''}</button>`).join('')}</div>
          <p class="muted small">${t(`theme_${theme.id}`)}</p>
        </div>
        <div class="conv-info-section"><h4>📌 ${t('pinnedMessages')}</h4>
          ${pinned.length ? pinned.map((m) => `<button type="button" class="pinned-item" data-act="jump-message" data-id="${m.id}"><b>${escapeHtml((byId[m.senderId]?.name || '').split(' ')[0])}</b><span class="grow">${escapeHtml(messageSnippet(m, 80))}</span><span class="muted small">${timeAgo(m.createdAt)}</span></button>`).join('') : `<p class="muted small">${t('noPinnedMessages')}</p>`}
        </div>
        ${active.isGroup ? `<div class="conv-info-section"><h4>👥 ${t('members')}</h4>${active.conv.participants.map((id) => `<div class="row gap-sm">${avatarHtml(byId[id], 28)}<span>${escapeHtml(byId[id]?.name || '')}</span></div>`).join('')}</div>` : ''}
      </div>
      <div class="thread-body" id="thread-body" style="${theme.tint ? `background:${theme.tint};` : ''}${theme.bubble ? `--bubble-mine:${theme.bubble};` : ''}">
        ${active.msgs.map((m) => messageHtml(m, meUser, byId, active.isGroup)).join('') || '<p class="muted center">No messages yet. Say hello 👋</p>'}
      </div>
      <div class="typing-row" id="typing-row">${typingIndicatorHtml(active.conv, meUser, byId)}</div>
      <div class="composer-wrap">
        <div id="reply-preview" class="message-preview reply-preview hidden"></div>
        <div id="message-preview" class="message-preview hidden"></div>`; })()}
        <form id="message-form" data-conv="${active.conv.id}" class="message-form">
          <input type="file" id="msg-image-input" name="image" accept="image/*" hidden />
          <label class="btn btn-ghost btn-sm msg-attach" for="msg-image-input" title="${t('photo')}" aria-label="${t('photo')}">📷</label>
          <button type="button" class="btn btn-ghost btn-sm" data-act="emoji-toggle" title="Emoji" aria-label="Emoji">😊</button>
          <input name="text" placeholder="Type a message…" autocomplete="off" maxlength="2000" />
          <button type="button" class="btn btn-ghost btn-sm" id="voice-btn" data-act="voice-toggle" title="${t('voiceMessage')}" aria-label="${t('voiceMessage')}">🎤</button>
          <button class="btn btn-primary" type="submit">${t('send')}</button>
        </form>
        <div id="emoji-panel" class="emoji-panel hidden">
          ${CHAT_EMOJIS.map((e) => `<button type="button" class="emoji-btn" data-emoji-insert="${e}" aria-label="Insert ${e}">${e}</button>`).join('')}
        </div>
        <div id="voice-ui" class="voice-ui hidden">
          <span class="voice-dot"></span><span id="voice-time" class="mono">0:00</span><span class="grow small">${t('recording')}…</span>
          <button class="btn btn-ghost btn-sm" data-act="voice-cancel">✕ ${t('cancel')}</button>
          <button class="btn btn-primary btn-sm" data-act="voice-send">${t('send')}</button>
        </div>
      </div>` : `<div class="empty-state"><div class="empty-icon">💬</div><p class="muted">${t('selectConversation')}</p></div>`}
    </div>
  </div>`;
}

// Emoji set for the Messenger picker (~24 common ones).
const CHAT_EMOJIS = ['😀', '😂', '🤣', '😍', '🥰', '😊', '😎', '🤔', '😴', '😢', '😮', '😅', '😭', '👍', '👏', '🙏', '❤️', '🔥', '🎉', '✨', '🌙', '☕', '🍰', '📷'];

function messageHtml(m, meUser, byId, isGroup = false) {
  const mine = m.senderId === meUser.id;
  // Own-message status as words (Facebook-style): "Seen" once any other
  // participant has it in readBy / the status flipped to read, else "Sent".
  const seen = m.status === 'read' || (m.readBy || []).length > 1;
  const status = mine ? (seen ? `✓✓ ${t('seen')}` : `✓ ${t('sent')}`) : '';
  const chips = reactionChips(m.reactions);
  return `<div class="msg-row ${mine ? 'mine' : ''}" id="msg-${m.id}">
    ${mine ? '' : avatarHtml(byId[m.senderId], 28)}
    <div class="msg-col">
    <div class="msg-bubble ${mine ? 'mine' : ''}">
      ${isGroup && !mine ? `<span class="msg-sender">${escapeHtml(byId[m.senderId]?.name || '')}</span>` : ''}
      ${m.replyToId ? `<button type="button" class="msg-quote" data-act="jump-message" data-id="${m.replyToId}"><b>${escapeHtml(m.replyToName || '')}</b><span>${escapeHtml(m.replyToText || '')}</span></button>` : ''}
      ${m.image ? `<img class="msg-image" src="${escapeHtml(cldImg(m.image, 800))}" alt="Shared photo" loading="lazy" decoding="async" />` : ''}
      ${m.audio ? `<audio class="msg-audio" controls preload="metadata" src="${escapeHtml(m.audio)}"></audio>` : ''}
      ${m.text ? `<p>${escapeHtml(m.text)}</p>` : ''}
      <div class="msg-picker hidden" id="msg-picker-${m.id}">${MESSAGE_REACTIONS.map((e) => `<button type="button" class="emoji-btn" data-act="msg-react" data-id="${m.id}" data-emoji="${e}" aria-label="${t('reactToMessage')} ${e}">${e}</button>`).join('')}</div>
      <span class="msg-foot"><span class="msg-meta">${m.pinned ? '📌 ' : ''}${timeAgo(m.createdAt)} ${status}</span><span class="msg-actions"><button type="button" class="link-btn msg-act-btn" data-act="reply-message" data-id="${m.id}" title="${t('replyToMessage')}" aria-label="${t('replyToMessage')}">↩️</button><button type="button" class="link-btn msg-act-btn" data-act="msg-react-toggle" data-id="${m.id}" title="${t('reactToMessage')}" aria-label="${t('reactToMessage')}">😊</button><button type="button" class="link-btn msg-act-btn ${m.pinned ? 'active' : ''}" data-act="pin-message" data-id="${m.id}" title="${t(m.pinned ? 'unpinMessage' : 'pinMessage')}" aria-label="${t(m.pinned ? 'unpinMessage' : 'pinMessage')}">📌</button>${mine ? '' : `<button class="link-btn msg-report-btn" data-act="report-message" data-id="${m.id}" title="${t('report')}" aria-label="${t('report')}">🚩</button>`}</span></span>
    </div>
    ${chips.length ? `<div class="msg-chips">${chips.map((c) => `<button type="button" class="msg-chip ${c.uids.includes(meUser.id) ? 'mine' : ''}" data-act="msg-react" data-id="${m.id}" data-emoji="${c.emoji}" title="${t('reactToMessage')}">${c.emoji} ${c.count}</button>`).join('')}</div>` : ''}
    </div>
  </div>`;
}

// "X is typing…" line for the open thread. Exported because main.js
// refreshes JUST this row on a 1s ticker (a full re-render would yank
// focus out of the composer input, and softRender is suppressed while
// typing). Group chats name up to two typers, then "and others".
export function typingIndicatorHtml(conv, meUser, byId, now = Date.now()) {
  const names = typingUserIds(conv, meUser?.id || '', now)
    .map((id) => (byId[id]?.name || '').split(' ')[0])
    .filter(Boolean);
  if (!names.length) return '';
  let text;
  if (names.length === 1) text = t('typingOne').replace('{name}', names[0]);
  else if (names.length === 2) text = t('typingTwo').replace('{name1}', names[0]).replace('{name2}', names[1]);
  else text = t('typingMany').replace('{name1}', names[0]).replace('{name2}', names[1]);
  return `<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${escapeHtml(text)}</span>`;
}

// Pick-friends form for a new group conversation (accepted friends only).
export function groupChatFormHtml(d, meUser) {
  const byId = usersById(d);
  const friends = [...friendIdsOfData(d, meUser.id)].map((id) => byId[id]).filter(Boolean);
  return `<h3>👥 ${t('newGroupChat')}</h3>
  <form id="group-chat-form" class="stack">
    <label>${t('groupChat')}<input name="title" maxlength="60" placeholder="e.g. Weekend Plans" /></label>
    <div class="stack group-pick-list">
      ${friends.length ? friends.map((u) => `<label class="row gap-sm"><input type="checkbox" name="member" value="${u.id}" /> ${avatarHtml(u, 30)}<span>${escapeHtml(u.name)}</span></label>`).join('') : `<p class="muted small">${t('noFriendsForGroupChat')}</p><div><a class="btn btn-primary btn-sm" href="#/friends" data-close>🔍 ${t('findFriends')}</a></div>`}
    </div>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('newGroupChat')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ NOTIFICATIONS
// Notification bodies are stored as raw English text at creation time,
// but the common types are re-rendered here from i18n templates with
// the actor's name, so the page reads in the viewer's language no
// matter when (or by whom) the notification was created. Unknown /
// custom types (admin notices, bot events) fall back to the stored
// text. Exact duplicates (same type+actor+text within an hour —
// duplicate documents can exist in live mode) are collapsed so one
// event never fills the list.
const NOTIF_TEMPLATE_KEYS = {
  friend_request: 'notifFriendRequest', friend_accept: 'notifFriendAccept',
  like: 'notifLike', comment: 'notifComment', reply: 'notifReply',
  message: 'notifMessage', mention: 'notifMention', share: 'notifShare', follow: 'notifFollow'
};

export function notificationText(n, byId) {
  const key = NOTIF_TEMPLATE_KEYS[n.type];
  const actor = byId[n.actorId];
  if (key && actor?.name) return t(key).replace('{name}', actor.name);
  return n.text || '';
}

export function notificationsView(d, meUser) {
  const byId = usersById(d);
  const sorted = d.notifications.filter((n) => n.userId === meUser.id).sort((a, b) => b.createdAt - a.createdAt);
  const mine = collapseDuplicateNotifications(sorted);
  const icons = { friend_request: '👥', friend_accept: '✅', like: '❤️', comment: '💬', reply: '↩️', message: '✉️', mention: '@', share: '🔁', follow: '➕', group_join: '🏘️', page_follow: '📄', group_request: '📥', group_request_result: '🏘️', event_rsvp: '📅' };
  return `<div class="page narrow">
    <div class="row"><h2 class="grow">🔔 ${t('notifications')}</h2><button class="btn btn-ghost btn-sm" data-act="notif-read-all">${t('markAllRead')}</button></div>
    ${mine.map((n) => `<button class="card notif ${n.read ? '' : 'unread'}" data-act="notif-open" data-id="${n.id}" data-post="${n.postId || ''}" data-conv="${n.conversationId || ''}">
      ${avatarHtml(byId[n.actorId], 40)}<span class="grow left">${icons[n.type] || '🔔'} ${escapeHtml(notificationText(n, byId))}<br/><span class="muted small">${timeAgo(n.createdAt)}</span></span>
    </button>`).join('') || emptyState('🔔', t('noNotifications'))}
  </div>`;
}

// ------------------------------------------------------------------ SEARCH
export function searchView(d, meUser, queryText) {
  const q = String(queryText || '').trim().toLowerCase();
  const byId = usersById(d);
  const blocked = blockedIdsOfData(d, meUser.id);
  const users = q ? d.users.filter((u) => !blocked.has(u.id) && (u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))) : [];
  const friendIds = friendIdsOfData(d, meUser.id);
  const ctx = viewCtx(d, meUser);
  // Post search covers EVERY loaded post the viewer may see — bot posts,
  // page posts and group posts included — and matches the AUTHOR's name
  // and username (and the page name) as well as the post text, so
  // searching a person's name finds their posts too.
  const posts = q ? d.posts.filter((p) => {
    if (blocked.has(p.authorId)) return false;
    const author = byId[p.authorId];
    const haystack = `${p.text || ''} ${author?.name || ''} ${author?.username || ''} ${p.pageName || ''}`.toLowerCase();
    if (!haystack.includes(q)) return false;
    if (p.groupId) return canViewGroupPost(p, ctx.groupsById[p.groupId], meUser.id, blocked);
    return canViewPost(p, { viewerId: meUser.id, friendIds, blockedIds: blocked });
  }).sort((a, b) => b.createdAt - a.createdAt) : [];
  return `<div class="page">
    <h2>🔎 Search ${q ? `for “${escapeHtml(queryText)}”` : ''}</h2>
    <form id="search-page-form" class="search-box search-page-form" role="search">
      <input name="q" placeholder="${t('searchPlaceholder')}" value="${escapeHtml(queryText || '')}" autocomplete="off" />
      <button class="btn btn-primary" type="submit">${t('search')}</button>
    </form>
    <h3>People</h3>
    <div class="grid-people">${users.map((u) => {
      const rel = d.friendships.find((f) => (f.from === meUser.id && f.to === u.id) || (f.from === u.id && f.to === meUser.id));
      const mutual = mutualFriendCount(d.friendships, meUser.id, u.id);
      let action = '';
      if (u.id === meUser.id) action = '';
      else if (u.isBot) action = `<button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${u.id}">Chat with bot</button>`;
      else if (rel?.status === 'accepted') action = `<span class="badge badge-ok">✓ ${t('friendsLabel')}</span>`;
      else if (rel?.status === 'pending' && rel.from === meUser.id) action = `<button class="btn btn-ghost btn-sm" data-act="cancel-request" data-id="${rel.id}" title="${t('tapToCancel')}">✓ ${t('requestSent')}</button>`;
      else if (rel?.status === 'pending') action = `<button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${rel.id}">Accept request</button>`;
      else action = `<button class="btn btn-primary btn-sm" data-act="send-request" data-id="${u.id}">${t('addFriend')}</button>`;
      return `<div class="card person-card">${avatarHtml(u, 56)}<a href="#/profile/${u.id}"><b>${escapeHtml(u.name)}</b></a><span class="muted small">@${escapeHtml(u.username)}</span>${mutual > 0 ? `<span class="muted small">${mutual} ${mutual === 1 ? t('mutualFriend') : t('mutualFriends')}</span>` : ''}${u.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''}${action ? `<div class="row gap wrap center">${action}</div>` : ''}</div>`;
    }).join('') || '<p class="muted">No people matched.</p>'}</div>
    <h3>Posts</h3>
    ${posts.map((p) => postCardHtml(p, ctx)).join('') || '<p class="muted">No posts matched.</p>'}
    <p class="muted small">Searched as ${escapeHtml(byId[meUser.id]?.name || '')} — private content you cannot access is never shown.</p>
  </div>`;
}

// ------------------------------------------------------------------ SAVED
export function savedView(d, meUser) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  const posts = d.posts.filter((p) => (p.savedBy || []).includes(meUser.id)
    && (!p.groupId || canViewGroupPost(p, ctx.groupsById[p.groupId], meUser.id, blocked))).sort((a, b) => b.createdAt - a.createdAt);
  return `<div class="page narrow"><h2>🔖 ${t('saved')} posts</h2>${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('🔖', 'Posts you save will appear here.')}</div>`;
}

// ------------------------------------------------------------------ SETTINGS
export function settingsView(d, meUser, prefs) {
  const np = meUser.settings?.notifPrefs || {};
  const defaultPrivacy = meUser.settings?.defaultPostPrivacy || 'public';
  const prefLabels = {
    friend_request: t('prefFriendRequest'), like: t('prefLike'), comment: t('prefComment'),
    reply: t('prefReply'), message: t('prefMessage'), mention: t('prefMention'), follow: t('prefFollow')
  };
  const types = Object.keys(prefLabels);
  return `<div class="page narrow">
    <h2>⚙️ ${t('settings')}</h2>
    <div class="card stack">
      <h3>${t('settingsAccount')}</h3>
      <p><b>${escapeHtml(meUser.name)}</b> · @${escapeHtml(meUser.username)}<br/><span class="muted">${escapeHtml(meUser.email || '')}</span></p>
      <div class="row gap wrap">
        <button class="btn btn-ghost" data-act="edit-profile">✏️ ${t('editProfile')}</button>
        <button class="btn btn-ghost" data-act="change-password">✉️ ${t('sendResetEmail')}</button>
        <button class="btn btn-ghost settings-logout" data-act="logout">🚪 ${t('logout')}</button>
      </div>
    </div>
    <div class="card stack">
      <h3>${t('settingsAppearance')}</h3>
      <div class="row gap wrap">
        <button class="btn btn-ghost" data-act="toggle-theme">${prefs.theme === 'dark' ? '☀️ ' + t('lightMode') : '🌙 ' + t('darkMode')}</button>
        <label>${t('languageLabel')}
          <select id="locale-select" class="select-sm">
            <option value="en" ${prefs.locale === 'en' ? 'selected' : ''}>English</option>
            <option value="bn" ${prefs.locale === 'bn' ? 'selected' : ''}>বাংলা</option>
          </select>
        </label>
      </div>
    </div>
    <div class="card stack">
      <h3>${t('settingsNotifications')}</h3>
      <form id="notif-prefs-form" class="stack">
        ${types.map((type) => `<label class="notif-pref-row"><span class="grow">${prefLabels[type]}</span><input type="checkbox" name="${type}" ${np[type] === false ? '' : 'checked'} /></label>`).join('')}
        <label class="notif-pref-row"><span class="grow">🔔 ${t('browserNotifications')}</span><input type="checkbox" name="browserNotifications" ${meUser.settings?.browserNotifications ? 'checked' : ''} /></label>
        <p class="muted small">${t('browserNotificationsHelp')}</p>
        <div><button class="btn btn-primary btn-sm" type="submit">${t('savePreferences')}</button></div>
      </form>
    </div>
    <div class="card stack">
      <h3>${t('settingsPrivacy')}</h3>
      <form id="privacy-prefs-form" class="stack">
        <label>${t('defaultPostPrivacy')}
          <select name="defaultPostPrivacy">
            <option value="public" ${defaultPrivacy === 'public' ? 'selected' : ''}>🌍 ${t('publicLabel')}</option>
            <option value="friends" ${defaultPrivacy === 'friends' ? 'selected' : ''}>👥 ${t('friends')}</option>
            <option value="close" ${defaultPrivacy === 'close' ? 'selected' : ''}>⭐ ${t('closeFriends')}</option>
            <option value="only-me" ${defaultPrivacy === 'only-me' ? 'selected' : ''}>🔒 ${t('onlyMe')}</option>
          </select>
        </label>
        <div><button class="btn btn-primary btn-sm" type="submit">${t('savePrivacy')}</button></div>
      </form>
      <p class="muted">${t('blockedHelp')}</p>
      ${(d.blocks || []).filter((b) => b.by === meUser.id).map((b) => `<div class="row gap-sm">${avatarHtml(usersById(d)[b.target], 32)}<span class="grow">${escapeHtml(usersById(d)[b.target]?.name || '')}</span><button class="btn btn-ghost btn-sm" data-act="block" data-id="${b.target}">${t('unblock')}</button></div>`).join('') || `<p class="muted small">${t('noBlocked')}</p>`}
      <div class="row gap wrap">
        <a class="btn btn-ghost btn-sm" href="#/privacy">${t('privacyPolicy')}</a>
        <a class="btn btn-ghost btn-sm" href="#/terms">${t('termsOfService')}</a>
        <a class="btn btn-ghost btn-sm" href="#/guidelines">${t('communityGuidelines')}</a>
        <a class="btn btn-ghost btn-sm" href="#/help">${t('help')}</a>
      </div>
    </div>
    <div class="card stack danger-zone">
      <h3>⚠️ ${t('dangerZone')}</h3>
      <p class="muted small">${t('dangerZoneHelp')}</p>
      <div><button class="btn btn-danger" data-act="delete-account">${t('deleteAccount')}</button></div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ ADMIN
// Super Admin Control Center (Pack A shell). main.js routes #/admin/*
// through adminShell() with one module view per route; Pack B (analytics,
// content, reports upgrade) and Pack C (bot tabs, announcements, site
// settings, health) add their modules as further shell routes — reuse
// adminShell, the utils role helpers and api.logAdminAction.
export function roleLabel(role) {
  const key = { user: 'roleUser', analyst: 'roleAnalyst', moderator: 'roleModerator', admin: 'roleAdmin', superadmin: 'roleSuperadmin', bot: 'aiBot' }[role];
  return key ? t(key) : String(role || '');
}

export function adminShell(d, meUser, active, content) {
  const openReports = (d.reports || []).filter((r) => reportNeedsAttention(r)).length;
  const links = [
    { key: 'overview', href: '#/admin', icon: '📊', label: t('adminOverview'), show: isStaff(meUser) },
    { key: 'analytics', href: '#/admin/analytics', icon: '📈', label: t('adminAnalytics'), show: isStaff(meUser) },
    { key: 'users', href: '#/admin/users', icon: '👥', label: t('adminUsers'), show: isAdminRole(meUser) },
    { key: 'content', href: '#/admin/content', icon: '🗂️', label: t('adminContent'), show: canModerate(meUser) },
    { key: 'bots', href: '#/admin/bots', icon: '🤖', label: t('adminBots'), show: isAdminRole(meUser) },
    { key: 'reports', href: '#/admin/reports', icon: '🚩', label: t('adminReports'), show: canModerate(meUser), badge: openReports },
    { key: 'announce', href: '#/admin/announce', icon: '📣', label: t('adminAnnounce'), show: isAdminRole(meUser) },
    { key: 'security', href: '#/admin/security', icon: '🔐', label: t('adminSecurity'), show: isAdminRole(meUser) },
    { key: 'settings', href: '#/admin/settings', icon: '⚙️', label: t('adminSettings'), show: isAdminRole(meUser) },
    { key: 'health', href: '#/admin/health', icon: '🩺', label: t('adminHealth'), show: isAdminRole(meUser) }
  ].filter((l) => l.show);
  return `<div class="admin-layout">
    <aside class="admin-sidebar">
      <div class="admin-side-head"><span class="admin-side-title">🛡️ ${t('adminPanel')}</span><span class="badge ${meUser.role === 'superadmin' ? 'badge-superadmin' : 'badge-admin'}">${escapeHtml(roleLabel(meUser.role))}</span></div>
      <nav class="admin-nav">${links.map((l) => `<a class="admin-nav-item ${active === l.key ? 'active' : ''}" href="${l.href}"><span class="admin-nav-icon">${l.icon}</span><span class="grow">${l.label}</span>${l.badge ? `<span class="nav-badge static">${l.badge}</span>` : ''}</a>`).join('')}</nav>
      <p class="muted small admin-side-note">${escapeHtml(meUser.name)} · @${escapeHtml(meUser.username)}</p>
    </aside>
    <div class="admin-main">${content}</div>
  </div>`;
}

export function adminDeniedView() {
  return `<div class="card empty-state"><div class="empty-icon">🔒</div><p class="muted">${t('accessDenied')}</p></div>`;
}

// #/admin — overview dashboard (Pack B). Every number comes from
// utils.platformStats over the dataset the admin client actually
// holds, upgraded per-metric by api.loadAdminStats server aggregates
// in live mode; a metric served from the loaded subset is labelled
// "from loaded data" rather than presented as a platform total.
export function adminOverviewView(d, meUser, mode) {
  const s = platformStats(d, Date.now(), d.adminStats || null);
  const readOnly = !isAdminRole(meUser); // analysts (and moderators) get no action controls
  const note = (metric) => (mode.firebase && s.sources[metric] === 'loaded' ? ` · ${t('statFromLoaded')}` : '');
  const stat = (value, label, metric = '') => `<div class="card stat"><b>${value}</b><span>${label}${metric ? note(metric) : ''}</span></div>`;
  return `<h2>🛡️ ${t('adminOverview')}</h2>
    <div class="stat-grid">
      ${stat(s.totalAccounts, `${t('statUsers')} · 👤 ${s.totalUsers} · 🤖 ${s.botAccounts}`)}
      ${stat(s.newToday, t('statNewToday'))}
      ${stat(s.new7d, t('statNew7d'))}
      ${stat(s.new30d, t('statNew30d'))}
      ${stat(s.onlineNow, t('statOnlineNow'))}
      ${stat(s.activeUsers7d, t('statActiveUsers'))}
      ${stat(s.totalPosts, t('statPosts'), 'posts')}
      ${stat(s.totalComments, t('statComments'), 'comments')}
      ${stat(s.totalLikes, t('statLikes'), 'likes')}
      ${stat(s.totalMessages, t('statMessages'), 'messages')}
      ${stat(s.totalBots, t('statBots'))}
      ${stat(s.activeBots, t('statBotsActive'))}
      ${stat(s.disabledBots, t('statBotsDisabled'))}
      ${stat(s.pendingReports, t('statPendingReports'))}
    </div>
    <div class="card stack">
      <h3>System status</h3>
      <p>Mode: <b>${mode.firebase ? 'Live Firebase' : 'Demo / offline'}</b> · Project: <b>${escapeHtml(mode.projectId)}</b> · Auth: ${mode.firebase ? 'Firebase Authentication' : 'Local demo accounts'} · Firestore: ${mode.firebase ? 'connected' : 'local store'} · Storage: ${mode.firebase ? 'Storage with compressed data-URL fallback (Blaze enables full Storage)' : 'local data URLs'}</p>
      ${readOnly ? '' : `<label class="row gap-sm"><input type="checkbox" id="maintenance-toggle" ${d.config?.maintenanceMode ? 'checked' : ''} /> <span class="grow">Maintenance mode (shows a maintenance banner to non-admin users)</span></label>
      <div class="row gap wrap"><a class="btn btn-primary btn-sm" href="#/admin/bots">🤖 Open Bot Admin Panel</a><button class="btn btn-ghost btn-sm" data-act="reset-demo">Reset demo data</button></div>`}
      <p class="muted small">Admin rights are enforced server-side: Firestore rules check users/{uid}.role and Cloud Functions verify admin before privileged actions. This page is only the interface.</p>
    </div>`;
}

// ----------------------------------------------------- analytics (B)
// Dependency-free inline SVG charts over utils.analyticsSeries. Bars
// carry <title> tooltips (day + value); the full series is also in the
// data table under the charts, and the CSV export (main.js) downloads
// exactly the series on screen.
const CHART_W = 720;
const CHART_H = 132;
function svgBarStack(rows, segments, height = CHART_H) {
  const max = Math.max(1, ...rows.map((r) => segments.reduce((n, s) => n + (Number(r[s.key]) || 0), 0)));
  const bw = CHART_W / Math.max(1, rows.length);
  const base = height - 14;
  const rects = [];
  rows.forEach((r, i) => {
    let y = base;
    for (const s of segments) {
      const v = Number(r[s.key]) || 0;
      if (!v) continue;
      const h = Math.max(1.5, (v / max) * (base - 10));
      y -= h;
      rects.push(`<rect x="${(i * bw + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"><title>${escapeHtml(r.day)} · ${escapeHtml(s.label)}: ${v}</title></rect>`);
    }
  });
  return `<svg class="chart" viewBox="0 0 ${CHART_W} ${height}" role="img" preserveAspectRatio="none"><line x1="0" y1="${base}" x2="${CHART_W}" y2="${base}" class="chart-axis"/>${rects.join('')}</svg>
    <div class="row gap wrap chart-legend">${segments.map((s) => `<span class="small"><span class="chart-swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`).join('')}<span class="muted small grow right">max ${max}/day</span></div>`;
}
function svgLine(rows, key, height = CHART_H) {
  const max = Math.max(1, ...rows.map((r) => Number(r[key]) || 0));
  const base = height - 14;
  const stepX = rows.length > 1 ? CHART_W / (rows.length - 1) : CHART_W;
  const y = (v) => base - ((Number(v) || 0) / max) * (base - 10);
  const pts = rows.map((r, i) => `${(i * stepX).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const dots = rows.length <= 31 ? rows.map((r, i) => `<circle cx="${(i * stepX).toFixed(1)}" cy="${y(r[key]).toFixed(1)}" r="2.4" class="chart-dot"><title>${escapeHtml(r.day)}: ${r[key]}</title></circle>`).join('') : '';
  return `<svg class="chart" viewBox="0 0 ${CHART_W} ${height}" role="img" preserveAspectRatio="none"><line x1="0" y1="${base}" x2="${CHART_W}" y2="${base}" class="chart-axis"/><polygon points="0,${base} ${pts} ${CHART_W},${base}" class="chart-area"/><polyline points="${pts}" class="chart-line"/>${dots}</svg>
    <div class="row gap wrap chart-legend"><span class="muted small grow right">max ${max}</span></div>`;
}

// #/admin/analytics — platform analytics (analyst+). Aggregates only.
export function adminAnalyticsView(d, meUser, filters = {}) {
  const days = [7, 30, 90, 365].includes(Number(filters.days)) ? Number(filters.days) : 30;
  const rows = analyticsSeries(d, days);
  const rangeBtn = (n) => `<a class="btn ${n === days ? 'btn-primary' : 'btn-ghost'} btn-sm" href="#/admin/analytics?days=${n}">${t(`last${n}Days`)}</a>`;
  const chartCard = (title, body, noteText = '') => `<div class="card stack chart-card"><h3>${title}</h3>${body}${noteText ? `<p class="muted small">${noteText}</p>` : ''}</div>`;
  const tableRows = [...rows].reverse();
  return `<h2>📈 ${t('adminAnalytics')}</h2>
    <div class="row gap wrap admin-filter card">
      ${rangeBtn(7)}${rangeBtn(30)}${rangeBtn(90)}${rangeBtn(365)}
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" data-act="admin-export-analytics" data-days="${days}">⬇️ ${t('exportCsv')}</button>
    </div>
    <p class="muted small">${t('analyticsNote')}</p>
    <div class="chart-grid">
      ${chartCard(`📈 ${t('chartUserGrowth')}`, svgLine(rows, 'totalUsers'))}
      ${chartCard(`👥 ${t('chartRegistrations')}`, svgBarStack(rows, [{ key: 'registrations', color: '#1877f2', label: t('colRegistrations') }]))}
      ${chartCard(`📝 ${t('chartPostsPerDay')}`, svgBarStack(rows, [{ key: 'posts', color: '#2e9e5b', label: t('statPosts') }]))}
      ${chartCard(`❤️ ${t('chartEngagement')}`, svgBarStack(rows, [{ key: 'engagement', color: '#e5534b', label: t('colEngagement') }]), t('chartEngagementNote'))}
      ${chartCard(`🤖 ${t('chartBotVsHuman')}`, svgBarStack(rows, [
        { key: 'humanPosts', color: '#1877f2', label: t('colHumanPosts') },
        { key: 'botPosts', color: '#8957e5', label: t('colBotPosts') }
      ]))}
      ${chartCard(`🚩 ${t('chartReports')}`, svgBarStack(rows, [
        { key: 'reportsPending', color: '#e0a800', label: t('reportStatusPending') },
        { key: 'reportsReview', color: '#1877f2', label: t('reportStatusReview') },
        { key: 'reportsResolved', color: '#2e9e5b', label: t('reportStatusResolved') },
        { key: 'reportsRejected', color: '#d64545', label: t('reportStatusRejected') },
        { key: 'reportsEscalated', color: '#8957e5', label: t('reportStatusEscalated') }
      ]))}
    </div>
    <div class="card">
      <div class="table-wrap"><table class="table">
        <thead><tr><th>${t('colDay')}</th><th>${t('colRegistrations')}</th><th>${t('colTotalUsers')}</th><th>${t('statPosts')}</th><th>${t('colEngagement')}</th><th>${t('colBotPosts')}</th><th>${t('colHumanPosts')}</th><th>${t('colReports')}</th></tr></thead>
        <tbody>${tableRows.map((r) => `<tr><td>${escapeHtml(r.day)}</td><td>${r.registrations}</td><td>${r.totalUsers}</td><td>${r.posts}</td><td>${r.engagement}</td><td>${r.botPosts}</td><td>${r.humanPosts}</td><td>${r.reportsTotal}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

// ------------------------------------------------------- content (B)
// #/admin/content — moderation over the posts the admin client has
// loaded: Posts (search/filter/paginate/delete), Comments (flattened,
// delete), Possible spam (labelled heuristics, same delete actions).
export function adminContentView(d, meUser, filters = {}) {
  const tab = ['posts', 'comments', 'spam'].includes(filters.tab) ? filters.tab : 'posts';
  const byId = usersById(d);
  const tabLink = (key, label, count) => `<a class="btn ${tab === key ? 'btn-primary' : 'btn-ghost'} btn-sm" href="#/admin/content?tab=${key}">${label} (${count})</a>`;
  const flatComments = [];
  for (const p of d.posts || []) {
    for (const c of p.comments || []) {
      flatComments.push({ post: p, entry: c, isReply: false });
      for (const r of c.replies || []) flatComments.push({ post: p, entry: r, isReply: true });
    }
  }
  flatComments.sort((a, b) => (b.entry.createdAt || 0) - (a.entry.createdAt || 0));
  const suspects = tab === 'spam' ? spamSuspects(d.posts || []) : [];
  let body = '';
  if (tab === 'posts') {
    const q = String(filters.q || '').trim().toLowerCase();
    const kindF = filters.kind || 'all';
    const list = (d.posts || []).filter((p) => {
      const author = byId[p.authorId];
      if (kindF === 'human' && author?.isBot) return false;
      if (kindF === 'bot' && !author?.isBot) return false;
      if (q && !`${p.text || ''} ${author?.name || ''} ${author?.username || ''}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const pageSize = 25;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    const page = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
    const rowsPage = list.slice((page - 1) * pageSize, page * pageSize);
    const pageHref = (n) => `#/admin/content?tab=posts&q=${encodeURIComponent(filters.q || '')}&kind=${kindF}&page=${n}`;
    body = `<form id="admin-content-filter" class="card admin-filter">
        <input type="hidden" name="tab" value="posts" />
        <input name="q" value="${escapeHtml(filters.q || '')}" placeholder="${t('userSearchPlaceholder')}" autocomplete="off" />
        <select name="kind" aria-label="${t('allAuthors')}">
          <option value="all" ${kindF === 'all' ? 'selected' : ''}>${t('allAuthors')}</option>
          <option value="human" ${kindF === 'human' ? 'selected' : ''}>${t('humans')}</option>
          <option value="bot" ${kindF === 'bot' ? 'selected' : ''}>${t('bots')}</option>
        </select>
        <button class="btn btn-primary btn-sm" type="submit">${t('search')}</button>
      </form>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Author</th><th>${t('statPosts')}</th><th>💬</th><th>❤️</th><th>${t('auditTime')}</th><th>${t('actionsLabel')}</th></tr></thead>
        <tbody>${rowsPage.map((p) => { const a = byId[p.authorId]; return `<tr>
          <td><a class="row gap-sm" href="#/profile/${p.authorId}">${avatarHtml(a, 28)}<span>${escapeHtml(a?.name || '?')}</span></a>${a?.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}</td>
          <td><a href="#/profile/${p.authorId}">${escapeHtml(truncate(p.text || '', 120))}</a></td>
          <td>${countPostComments(p)}</td><td>${(p.likes || []).length}</td>
          <td>${timeAgo(p.createdAt)}</td>
          <td><button class="btn btn-danger btn-sm" data-act="admin-content-delete-post" data-id="${p.id}">${t('delete')}</button></td>
        </tr>`; }).join('') || `<tr><td colspan="6" class="muted center">${t('noContentFound')}</td></tr>`}</tbody>
      </table></div>
      <div class="row gap admin-pager">
        ${page > 1 ? `<a class="btn btn-ghost btn-sm" href="${pageHref(page - 1)}">${t('prevPage')}</a>` : ''}
        <span class="muted small grow center">${t('pageLabelOf')} ${page} / ${totalPages} · ${list.length}</span>
        ${page < totalPages ? `<a class="btn btn-ghost btn-sm" href="${pageHref(page + 1)}">${t('nextPage')}</a>` : ''}
      </div></div>`;
  } else if (tab === 'comments') {
    const pageSize = 25;
    const totalPages = Math.max(1, Math.ceil(flatComments.length / pageSize));
    const page = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
    const rowsPage = flatComments.slice((page - 1) * pageSize, page * pageSize);
    const pageHref = (n) => `#/admin/content?tab=comments&page=${n}`;
    body = `<div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Author</th><th>${t('comment')}</th><th>${t('statPosts')}</th><th>${t('auditTime')}</th><th>${t('actionsLabel')}</th></tr></thead>
      <tbody>${rowsPage.map(({ post, entry, isReply }) => { const a = byId[entry.authorId]; const pa = byId[post.authorId]; return `<tr>
        <td><a class="row gap-sm" href="#/profile/${entry.authorId}">${avatarHtml(a, 28)}<span>${escapeHtml(a?.name || '?')}</span></a>${a?.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}</td>
        <td>${isReply ? '↩️ ' : ''}${escapeHtml(truncate(entry.text || '', 140))}</td>
        <td><a href="#/profile/${post.authorId}">${escapeHtml(truncate(post.text || '', 60))}</a> <span class="muted small">· ${escapeHtml(pa?.name || '')}</span></td>
        <td>${timeAgo(entry.createdAt)}</td>
        <td><button class="btn btn-danger btn-sm" data-act="admin-content-delete-comment" data-post="${post.id}" data-id="${entry.id}">${t('delete')}</button></td>
      </tr>`; }).join('') || `<tr><td colspan="5" class="muted center">${t('noContentFound')}</td></tr>`}</tbody>
    </table></div>
    <div class="row gap admin-pager">
      ${page > 1 ? `<a class="btn btn-ghost btn-sm" href="${pageHref(page - 1)}">${t('prevPage')}</a>` : ''}
      <span class="muted small grow center">${t('pageLabelOf')} ${page} / ${totalPages} · ${flatComments.length}</span>
      ${page < totalPages ? `<a class="btn btn-ghost btn-sm" href="${pageHref(page + 1)}">${t('nextPage')}</a>` : ''}
    </div></div>`;
  } else {
    const flagLabel = { repeat: t('flagRepeat'), links: t('flagLinks'), burst: t('flagBurst') };
    body = `<p class="muted">⚠️ ${t('spamHeuristicNote')}</p>
    <div class="card stack">
      ${suspects.map(({ post, flags }) => { const a = byId[post.authorId]; return `<div class="row gap-sm wrap">
        ${avatarHtml(a, 32)}
        <span class="grow"><a href="#/profile/${post.authorId}"><b>${escapeHtml(a?.name || '?')}</b></a> · ${timeAgo(post.createdAt)}<br/><a href="#/profile/${post.authorId}">${escapeHtml(truncate(post.text || '', 160))}</a></span>
        ${flags.map((f) => `<span class="badge badge-warn">${escapeHtml(flagLabel[f] || f)}</span>`).join('')}
        <button class="btn btn-danger btn-sm" data-act="admin-content-delete-post" data-id="${post.id}">${t('delete')}</button>
      </div>`; }).join('') || `<p class="muted">${t('noContentFound')}</p>`}
    </div>`;
  }
  return `<h2>🗂️ ${t('adminContent')}</h2>
    <div class="row gap wrap">
      ${tabLink('posts', `📝 ${t('contentPostsTab')}`, (d.posts || []).length)}
      ${tabLink('comments', `💬 ${t('contentCommentsTab')}`, flatComments.length)}
      ${tabLink('spam', `🛡️ ${t('contentSpamTab')}`, spamSuspects(d.posts || []).length)}
    </div>
    ${body}`;
}

// -------------------------------------------------- reports center (B)
export function reportCategoryLabel(cat) {
  const key = { fake: 'reportCatFake', harassment: 'reportCatHarassment', spam: 'reportCatSpam', inappropriate: 'reportCatInappropriate', impersonation: 'reportCatImpersonation', bot: 'reportCatBot', other: 'reportCatOther' }[cat];
  return key ? t(key) : String(cat || '');
}
export function reportStatusLabel(status) {
  const key = { pending: 'reportStatusPending', review: 'reportStatusReview', resolved: 'reportStatusResolved', rejected: 'reportStatusRejected', escalated: 'reportStatusEscalated' }[status];
  return key ? t(key) : String(status || '');
}
export function reportOutcomeLabel(outcome) {
  const key = { none: 'outcomeNone', 'content-removed': 'outcomeContentRemoved', 'user-warned': 'outcomeUserWarned', 'user-suspended': 'outcomeUserSuspended' }[outcome];
  return key ? t(key) : String(outcome || '');
}
export function appealStatusLabel(status) {
  const key = { none: 'appealNone', requested: 'appealRequested', accepted: 'appealAccepted', declined: 'appealDeclined' }[status];
  return key ? t(key) : String(status || '');
}

// User-side report dialog (post / user / message): a category select +
// a free-text reason. Message reports additionally snapshot the single
// reported message as evidence inside api.reportContent.
export function reportFormHtml(targetType, targetId) {
  return `<h3>🚩 ${t('reportDialogTitle')}</h3>
  <form id="report-form" data-type="${escapeHtml(targetType)}" data-id="${escapeHtml(targetId)}" class="stack">
    <label>${t('categoryLabel')}<select name="category">${REPORT_CATEGORIES.map((c) => `<option value="${c}">${escapeHtml(reportCategoryLabel(c))}</option>`).join('')}</select></label>
    <label>${t('reportReasonLabel')}<textarea name="reason" rows="3" maxlength="500" required placeholder="${t('reportReasonLabel')}"></textarea></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>${t('cancel')}</button><button class="btn btn-primary" type="submit">${t('reportSubmit')}</button></div>
  </form>`;
}

// Resolve dialog: the moderator picks the outcome; side effects
// (delete content / warn / suspend) run inside api.adminDecideReport.
export function reportResolveFormHtml(report) {
  return `<h3>✅ ${t('resolveReport')}</h3>
  <form id="report-resolve-form" data-id="${escapeHtml(report.id)}" class="stack">
    <label>${t('outcomeLabel')}<select name="outcome">${REPORT_OUTCOMES.map((o) => `<option value="${o}">${escapeHtml(reportOutcomeLabel(o))}</option>`).join('')}</select></label>
    <label>${t('reasonLabel')}<input name="reason" maxlength="200" placeholder="${t('reasonPlaceholder')}" autocomplete="off" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>${t('cancel')}</button><button class="btn btn-primary" type="submit">${t('resolveReport')}</button></div>
  </form>`;
}

// #/admin/reports — the Report Management Center. Status filter tabs
// with counts; each card shows the category, target, reporter, the
// user-submitted evidence for message reports (never a conversation),
// the moderation history (decision record) and appeal controls.
export function reportsView(d, meUser, filters = {}) {
  const byId = usersById(d);
  const statusF = filters.status || 'all';
  const all = [...(d.reports || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const counts = { all: all.length, pending: 0, review: 0, resolved: 0, rejected: 0, escalated: 0 };
  for (const r of all) counts[reportStatus(r)] += 1;
  const list = statusF === 'all' ? all : all.filter((r) => reportStatus(r) === statusF);
  const tabLink = (key, label) => `<a class="btn ${statusF === key ? 'btn-primary' : 'btn-ghost'} btn-sm" href="#/admin/reports?status=${key}">${label} (${key === 'all' ? counts.all : counts[key] || 0})</a>`;
  const statusBadge = (st) => `<span class="badge ${st === 'pending' || st === 'escalated' ? 'badge-warn' : st === 'resolved' ? 'badge-ok' : st === 'rejected' ? 'badge-danger' : ''}">${escapeHtml(reportStatusLabel(st))}</span>`;
  const targetHtml = (r) => {
    if (r.targetType === 'post') {
      const p = (d.posts || []).find((x) => x.id === r.targetId);
      const a = p ? byId[p.authorId] : null;
      return `${t('statPosts')}: ${p ? `<a href="#/profile/${p.authorId}">${escapeHtml(truncate(p.text || '', 80))}</a> <span class="muted small">· ${escapeHtml(a?.name || '')}</span>` : `<span class="muted">${escapeHtml(r.targetId)}</span>`}`;
    }
    if (r.targetType === 'user') {
      const u = byId[r.targetId];
      return `${t('roleUser')}: ${u ? `<a href="#/profile/${u.id}">${escapeHtml(u.name)}</a> <span class="muted small">@${escapeHtml(u.username)}</span>` : `<span class="muted">${escapeHtml(r.targetId)}</span>`}`;
    }
    if (r.targetType === 'message') {
      const sender = byId[r.evidence?.senderId];
      return `${t('messages')}: ${sender ? `<a href="#/profile/${sender.id}">${escapeHtml(sender.name)}</a>` : `<span class="muted">${escapeHtml(r.evidence?.senderId || '')}</span>`}`;
    }
    return `${escapeHtml(r.targetType)} · ${escapeHtml(r.targetId)}`;
  };
  const card = (r) => {
    const st = reportStatus(r);
    const reporter = byId[r.reporterId];
    const dec = r.decision || null;
    const appeal = r.appeal?.status || 'none';
    const actionable = ['pending', 'review', 'escalated'].includes(st);
    return `<div class="card stack report-card">
      <div class="row gap-sm wrap">
        ${statusBadge(st)}
        <span class="badge">${escapeHtml(reportCategoryLabel(reportCategory(r)))}</span>
        <span class="grow"><b>${t('targetLabel')}:</b> ${targetHtml(r)}</span>
        <span class="muted small">${timeAgo(r.createdAt)}</span>
      </div>
      <p class="small"><b>${t('reportedByLabel')}:</b> ${reporter ? `<a href="#/profile/${reporter.id}">${escapeHtml(reporter.name)}</a>` : escapeHtml(r.reporterId || '')} · <b>${t('reportReasonLabel')}</b> ${escapeHtml(r.reason || '')}</p>
      ${r.targetType === 'message' && r.evidence ? `<div class="evidence-box"><span class="muted small">🔒 ${t('evidenceLabel')}</span><blockquote>${escapeHtml(r.evidence.text || '')}</blockquote></div>` : ''}
      ${dec ? `<p class="small muted">⚖️ ${t('decisionByLabel')}: <b>${escapeHtml(reportOutcomeLabel(dec.outcome || 'none'))}</b> · ${escapeHtml(dec.byName || '')} · ${timeAgo(dec.at)}${dec.reason ? ` · “${escapeHtml(dec.reason)}”` : ''}</p>` : ''}
      <div class="row gap-sm wrap">
        <span class="small"><b>${t('appealLabel')}:</b> ${escapeHtml(appealStatusLabel(appeal))}</span>
        ${appeal === 'accepted' ? `<span class="muted small">${t('appealNoRestore')}</span>` : ''}
        <span class="spacer"></span>
        ${appeal !== 'requested' ? `<button class="btn btn-ghost btn-sm" data-act="report-appeal" data-id="${r.id}" data-appeal="requested">${t('appealMarkRequested')}</button>` : ''}
        ${appeal !== 'accepted' ? `<button class="btn btn-ghost btn-sm" data-act="report-appeal" data-id="${r.id}" data-appeal="accepted">${t('appealAccept')}</button>` : ''}
        ${appeal !== 'declined' ? `<button class="btn btn-ghost btn-sm" data-act="report-appeal" data-id="${r.id}" data-appeal="declined">${t('appealDecline')}</button>` : ''}
      </div>
      ${actionable ? `<div class="row gap-sm wrap">
        ${st !== 'review' ? `<button class="btn btn-ghost btn-sm" data-act="report-review" data-id="${r.id}">🔍 ${t('markUnderReview')}</button>` : ''}
        <button class="btn btn-primary btn-sm" data-act="report-resolve-open" data-id="${r.id}">✅ ${t('resolveReport')}</button>
        <button class="btn btn-ghost btn-sm" data-act="report-reject" data-id="${r.id}">✖ ${t('rejectReport')}</button>
        ${st !== 'escalated' ? `<button class="btn btn-ghost btn-sm" data-act="report-escalate" data-id="${r.id}">⬆️ ${t('escalateReport')}</button>` : ''}
      </div>` : ''}
    </div>`;
  };
  return `<h2>🚩 ${t('adminReports')}</h2>
    <div class="row gap wrap">
      ${tabLink('all', t('allReports'))}
      ${tabLink('pending', t('reportStatusPending'))}
      ${tabLink('review', t('reportStatusReview'))}
      ${tabLink('resolved', t('reportStatusResolved'))}
      ${tabLink('rejected', t('reportStatusRejected'))}
      ${tabLink('escalated', t('reportStatusEscalated'))}
    </div>
    <div class="stack">${list.map(card).join('') || `<div class="card empty-state"><p class="muted">${t('noContentFound')}</p></div>`}</div>`;
}

// #/admin/users — User Management (Pack A). All rows come from the
// synced users collection; filters + pagination are client-side over
// that set (25/page). Every action routes through main.js → api admin
// functions, which re-check the same utils guards and write an audit
// entry — the buttons hidden here are a convenience, not the control.
export function adminUsersView(d, meUser, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  const statusF = filters.status || 'all';
  const roleF = filters.role || 'all';
  const kindF = filters.kind || 'all';
  const postCounts = new Map();
  for (const p of d.posts) postCounts.set(p.authorId, (postCounts.get(p.authorId) || 0) + 1);
  const list = d.users.filter((u) => {
    if (kindF === 'humans' && u.isBot) return false;
    if (kindF === 'bots' && !u.isBot) return false;
    if (statusF !== 'all' && accountStatus(u) !== statusF) return false;
    if (roleF !== 'all' && u.role !== roleF) return false;
    if (q && !`${u.name} ${u.username} ${u.email}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const rows = list.slice((page - 1) * pageSize, page * pageSize);
  const pageHref = (n) => `#/admin/users?q=${encodeURIComponent(filters.q || '')}&status=${statusF}&role=${roleF}&kind=${kindF}&page=${n}`;
  const statusBadge = (u) => {
    const st = accountStatus(u);
    return st === 'active'
      ? `<span class="badge badge-ok">${t('statusActive')}</span>`
      : st === 'suspended'
        ? `<span class="badge badge-warn">${t('statusSuspended')}</span>`
        : `<span class="badge badge-danger">${t('statusBanned')}</span>`;
  };
  const rowActions = (u) => {
    if (u.isBot) return '<span class="muted small">🤖</span>';
    const bits = [];
    if (canManageUser(meUser, u)) {
      const st = accountStatus(u);
      if (st === 'active') bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-suspend" data-id="${u.id}">${t('suspend')}</button>`);
      if (st === 'suspended') bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-unsuspend" data-id="${u.id}">${t('unsuspend')}</button>`);
      if (st !== 'banned') bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-ban" data-id="${u.id}">${t('ban')}</button>`);
      if (st === 'banned') bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-restore" data-id="${u.id}">${t('restore')}</button>`);
      bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-verify" data-id="${u.id}" data-verified="${u.verified ? '0' : '1'}">${u.verified ? t('unverify') : t('verify')}</button>`);
    }
    if (canChangeRole(meUser, u)) {
      bits.push(`<button class="btn btn-danger btn-sm" data-act="admin-user-delete" data-id="${u.id}">${t('delete')}</button>`);
    }
    return bits.length ? `<div class="row gap-sm wrap">${bits.join('')}</div>` : '<span class="muted small">—</span>';
  };
  const roleCell = (u) => {
    if (canChangeRole(meUser, u)) {
      return `<select class="admin-role-select" data-id="${u.id}" aria-label="${t('roleLabel')}">${ASSIGNABLE_ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${escapeHtml(roleLabel(r))}</option>`).join('')}</select>`;
    }
    return `<span class="badge ${u.role === 'superadmin' ? 'badge-superadmin' : u.role === 'admin' ? 'badge-admin' : ''}">${escapeHtml(roleLabel(u.role))}</span>`;
  };
  return `<h2>👥 ${t('adminUsers')}</h2>
    <form id="admin-user-filter" class="card admin-filter">
      <input name="q" value="${escapeHtml(filters.q || '')}" placeholder="${t('userSearchPlaceholder')}" autocomplete="off" />
      <select name="status" aria-label="${t('statusLabel')}">
        <option value="all" ${statusF === 'all' ? 'selected' : ''}>${t('allStatuses')}</option>
        <option value="active" ${statusF === 'active' ? 'selected' : ''}>${t('statusActive')}</option>
        <option value="suspended" ${statusF === 'suspended' ? 'selected' : ''}>${t('statusSuspended')}</option>
        <option value="banned" ${statusF === 'banned' ? 'selected' : ''}>${t('statusBanned')}</option>
      </select>
      <select name="role" aria-label="${t('roleLabel')}">
        <option value="all" ${roleF === 'all' ? 'selected' : ''}>${t('allRoles')}</option>
        ${ASSIGNABLE_ROLES.map((r) => `<option value="${r}" ${roleF === r ? 'selected' : ''}>${escapeHtml(roleLabel(r))}</option>`).join('')}
      </select>
      <select name="kind" aria-label="${t('allKinds')}">
        <option value="all" ${kindF === 'all' ? 'selected' : ''}>${t('allKinds')}</option>
        <option value="humans" ${kindF === 'humans' ? 'selected' : ''}>${t('humans')}</option>
        <option value="bots" ${kindF === 'bots' ? 'selected' : ''}>${t('bots')}</option>
      </select>
      <button class="btn btn-primary btn-sm" type="submit">${t('search')}</button>
    </form>
    <div class="card">
      <div class="table-wrap"><table class="table admin-users-table">
        <thead><tr><th>User</th><th>${t('username')}</th><th>${t('email')}</th><th>${t('roleLabel')}</th><th>${t('statusLabel')}</th><th>${t('joinedLabel')}</th><th>${t('postsCount')}</th><th>${t('friendsLabel')}</th><th>${t('actionsLabel')}</th></tr></thead>
        <tbody>${rows.map((u) => `<tr>
          <td><a class="row gap-sm" href="#/profile/${u.id}">${avatarHtml(u, 30)}<span>${userNameHtml(u)}</span></a></td>
          <td class="cell-nowrap">@${escapeHtml(u.username)}</td>
          <td class="cell-email">${escapeHtml(u.email || '')}</td>
          <td>${roleCell(u)}</td>
          <td class="cell-nowrap">${statusBadge(u)}</td>
          <td class="cell-nowrap">${u.createdAt ? escapeHtml(new Date(u.createdAt).toLocaleDateString()) : '—'}</td>
          <td>${postCounts.get(u.id) || 0}</td>
          <td>${friendIdsOfData(d, u.id).size}</td>
          <td>${rowActions(u)}</td>
        </tr>`).join('') || `<tr><td colspan="9" class="muted center">${t('noUsersMatch')}</td></tr>`}</tbody>
      </table></div>
      <div class="row gap admin-pager">
        ${page > 1 ? `<a class="btn btn-ghost btn-sm" href="${pageHref(page - 1)}">${t('prevPage')}</a>` : ''}
        <span class="muted small grow center">${t('pageLabelOf')} ${page} / ${totalPages} · ${list.length}</span>
        ${page < totalPages ? `<a class="btn btn-ghost btn-sm" href="${pageHref(page + 1)}">${t('nextPage')}</a>` : ''}
      </div>
    </div>`;
}

// #/admin/security — audit log viewer (Pack A). Entries come from the
// adminLogs collection (admins/superadmins only, enforced by rules);
// the filter matches the action text, newest first.
export function adminSecurityView(d, meUser, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  const logs = [...(d.adminLogs || [])]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .filter((l) => !q || String(l.action || '').toLowerCase().includes(q));
  return `<h2>🔐 ${t('adminSecurity')}</h2>
    <form id="admin-log-filter" class="card admin-filter">
      <input name="q" value="${escapeHtml(filters.q || '')}" placeholder="${t('auditFilterPlaceholder')}" autocomplete="off" />
      <button class="btn btn-primary btn-sm" type="submit">${t('search')}</button>
    </form>
    <div class="card stack">
      <h3>${t('auditLog')} (${logs.length})</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>${t('auditAdmin')}</th><th>${t('auditAction')}</th><th>${t('auditTarget')}</th><th>${t('auditReason')}</th><th>${t('auditTime')}</th></tr></thead>
        <tbody>${logs.map((l) => `<tr>
          <td>${escapeHtml(l.adminName || l.adminId || '')}</td>
          <td><span class="badge">${escapeHtml(l.action || '')}</span></td>
          <td>${escapeHtml(l.targetType || '')}${l.targetLabel ? `: ${escapeHtml(l.targetLabel)}` : ''}</td>
          <td>${escapeHtml(l.reason || '')}</td>
          <td title="${l.createdAt ? escapeHtml(new Date(l.createdAt).toLocaleString()) : ''}">${timeAgo(l.createdAt)}</td>
        </tr>`).join('') || `<tr><td colspan="5" class="muted center">${t('noAuditEntries')}</td></tr>`}</tbody>
      </table></div>
    </div>`;
}

// Full-screen notice shown INSTEAD of the app when the signed-in user's
// own account is suspended or banned (Pack A). Enforcement pairs with
// the writerStatusOk() create-rule gate in firestore.rules.
export function accountStatusView(user) {
  const banned = accountStatus(user) === 'banned';
  return `<div class="page narrow"><div class="card empty-state">
    <div class="empty-icon">${banned ? '⛔' : '⏸️'}</div>
    <h2>${t(banned ? 'accountBannedTitle' : 'accountSuspendedTitle')}</h2>
    <p class="muted">${t(banned ? 'accountBannedBody' : 'accountSuspendedBody')}</p>
    <button class="btn btn-primary" data-act="logout">${t('logout')}</button>
  </div></div>`;
}

// ------------------------------------------------------------------ BOTS ADMIN
export function botsView(d, meUser) {
  const globalOn = d.botSettings?.global?.enabled !== false;
  const aiCfg = resolveAiConfig(d.botSecrets || {}, d.config || {});
  const totals = usageTotals(d.aiUsage?.providers);
  return `<div class="admin-inner">
    <h2>🤖 AI Bot Admin Panel</h2>
    <div class="card stack">
      <div class="row gap wrap">
        <span class="grow"><b>Global bot kill switch</b><br/><span class="muted small">When off, no bot may post, comment, like or message — enforced in the bot engine and Cloud Functions.</span></span>
        <button class="btn ${globalOn ? 'btn-danger' : 'btn-primary'}" data-act="bot-kill-switch" data-on="${globalOn ? '0' : '1'}">${globalOn ? '⛔ Stop all bots' : '▶️ Enable bots'}</button>
        <button class="btn btn-ghost" data-act="bot-run-cycle">${t('botRunCycle')}</button>
        <button class="btn btn-primary" data-act="bot-new">+ Create bot</button>
      </div>
      <p class="muted small">Status: <b>${globalOn ? 'ENABLED' : 'STOPPED'}</b> · ${t('aiUsageToday')}: ${totals.calls} calls · ${totals.tokens} tokens reported by providers (template fallback uses 0 provider tokens).</p>
    </div>
    ${aiProvidersSection(d, aiCfg)}
    ${firebaseReady ? `<div class="card stack">
      <h3>🛰️ ${t('botRunnerTitle')}</h3>
      <p class="small"><b>${d.botRunner?.active ? t('botRunnerActive') : t('botRunnerInactive')}</b></p>
      ${d.botRunner?.lastCycleAt ? `<p class="small">${t('botLastCycle')}: ${timeAgo(d.botRunner.lastCycleAt)} — ${escapeHtml(d.botRunner.lastSummary || '')}</p>` : ''}
      ${(d.botRunner?.lastDetails || []).filter((x) => x.pendingDMs > 0).map((x) => `<p class="small">🤖 <b>${escapeHtml(x.bot)}</b>: ${escapeHtml(x.note || `${x.pendingDMs} unanswered DM(s)`)} <span class="muted">· latest unanswered ${timeAgo(x.lastUnansweredAt)}</span></p>`).join('')}
      <p class="muted small">${t('botRunnerNote')}</p>
    </div>` : ''}
    ${d.bots.map((b) => botCardHtml(d, b)).join('') || emptyState('🤖', 'No bots yet. Create your first AI bot.')}
    <div class="card stack">
      <h3>Recent bot activity</h3>
      ${d.botActivities.slice(0, 15).map((a) => `<p class="small">• <b>${escapeHtml(d.bots.find((x) => x.id === a.botId)?.name || a.botId)}</b> ${escapeHtml(a.action)} — ${escapeHtml(a.detail || '')} <span class="muted">${timeAgo(a.createdAt)} · ${escapeHtml(a.status || '')}</span></p>`).join('') || '<p class="muted">No activity yet.</p>'}
      <h3>Bot logs</h3>
      ${d.botLogs.slice(0, 10).map((l) => `<p class="small mono">[${escapeHtml(l.level)}] ${escapeHtml(l.message)} <span class="muted">${timeAgo(l.createdAt)}</span></p>`).join('') || '<p class="muted">No logs.</p>'}
    </div>
  </div>`;
}

// ------------------------------------------------- AI PROVIDERS (Stage A)
// One card per registry provider: free-status badge, the verified
// free terms, enable toggle, key/endpoint form, default model, TODAY's
// real usage from the per-provider counters, and a Test connection
// button whose last result renders inline. Paid-only providers stay
// locked (no key input at all) until the platform's paid approval is
// on — the gate is also enforced in api.saveProviderKey and in the
// router itself.
function aiProvidersSection(d, aiCfg) {
  const usage = d.aiUsage?.providers || {};
  const health = d.providerHealth || {};
  return `<div class="card stack">
      <h3>🔌 ${t('aiProvidersTitle')}</h3>
      <p class="muted small">${t('aiFallbackNote')}</p>
      <form id="ai-fallback-form" class="row gap wrap">
        <label class="grow">${t('fallbackOrderLabel')}<input name="order" value="${escapeHtml(aiCfg.fallbackOrder.join(', '))}" /></label>
        <button class="btn btn-primary" type="submit">${t('save')}</button>
      </form>
      <p class="muted small">${t('fallbackOrderHelp')}</p>
      <div class="row gap wrap">
        <span class="grow"><b>${t('paidApprovalLabel')}</b><br/><span class="muted small">${t('paidApprovalWarning')}</span></span>
        <button class="btn ${aiCfg.paidApproved ? 'btn-danger' : 'btn-ghost'}" data-act="ai-paid-toggle" data-on="${aiCfg.paidApproved ? '0' : '1'}">${aiCfg.paidApproved ? 'ON' : 'OFF'}</button>
      </div>
    </div>
    ${AI_PROVIDERS.map((entry) => providerCardHtml(entry, aiCfg.providers[entry.id] || {}, usage[entry.id] || {}, aiCfg.paidApproved, health[entry.id])).join('')}`;
}

function providerCardHtml(entry, cfg, usage, paidApproved, health) {
  const badge = entry.freeStatus === 'free'
    ? `<span class="badge badge-ok">${t('providerFree')}</span>`
    : entry.freeStatus === 'paid-only'
      ? `<span class="badge badge-warn">${t('providerPaidOnly')}</span>`
      : `<span class="badge">${t('providerSelfHosted')}</span>`;
  const locked = entry.freeStatus === 'paid-only' && !paidApproved;
  const hasKey = Boolean(cfg.apiKey);
  const tokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);
  const exhausted = usage.exhaustedUntil && usage.exhaustedUntil > Date.now();
  const modelForm = entry.models.length && !entry.freeText
    ? `<form data-provider-model-form="${entry.id}" class="row gap wrap">
        <label class="grow">${t('providerDefaultModelLabel')}<select name="model">${entry.models.map((m) => `<option value="${escapeHtml(m)}" ${cfg.defaultModel === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select></label>
        <button class="btn btn-ghost" type="submit">${t('save')}</button>
      </form>`
    : `<form data-provider-model-form="${entry.id}" class="row gap wrap">
        <label class="grow">${t('providerDefaultModelLabel')}<input name="model" value="${escapeHtml(cfg.defaultModel || '')}" placeholder="${escapeHtml(entry.defaultModel || 'provider/model-id')}" /></label>
        <button class="btn btn-ghost" type="submit">${t('save')}</button>
      </form>`;
  return `<div class="card stack provider-card" data-provider="${entry.id}">
    <div class="row gap wrap">
      <span class="grow"><b>${escapeHtml(entry.label)}</b> ${badge}<br/><span class="muted small">${escapeHtml(entry.blurb)}</span></span>
      <button class="btn ${cfg.enabled !== false ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="provider-toggle" data-id="${entry.id}" data-on="${cfg.enabled !== false ? '0' : '1'}">${cfg.enabled !== false ? 'Deactivate' : 'Activate'}</button>
      <button class="btn btn-ghost btn-sm" data-act="provider-test" data-id="${entry.id}">${t('providerTestBtn')}</button>
    </div>
    <p class="muted small">${escapeHtml(entry.rpmNote)} ${entry.dailyCap != null ? `· ${t('providerDailyCap')}: ${entry.dailyCap}` : `· ${t('providerNoDailyCap')}`}</p>
    ${entry.endpointField
      ? `<p class="small">${t('providerEndpointLabel')}: <b>${escapeHtml(cfg.endpoint || entry.baseUrl)}</b></p>`
      : `<p class="small">Status: <b>${hasKey ? t('providerKeySet') : t('providerKeyNotSet')}</b></p>`}
    <p class="small">${t('providerUsageToday')}: <b>${usage.calls || 0}</b> calls · <b>${usage.promptTokens || 0}</b> prompt + <b>${usage.completionTokens || 0}</b> completion tokens · <b>${usage.errors || 0}</b> errors${(usage.calls || 0) > 0 && tokens === 0 ? ` <span class="muted">(${t('providerTokensNotReported')})</span>` : ''}</p>
    ${exhausted ? `<p class="small">⚠️ ${t('providerRateLimited')}</p>` : ''}
    ${health ? `<p class="small">${t('lastTestLabel')}: <b>${health.ok ? '✓ OK' : '✗ Failed'}</b> — ${escapeHtml(health.detail || '')} <span class="muted">${timeAgo(health.at)}</span></p>` : ''}
    ${locked
      ? `<p class="muted small">🔒 ${escapeHtml(entry.paidNote || '')} ${t('providerLockedNote')}</p>`
      : entry.endpointField
        ? `<form data-provider-endpoint-form="${entry.id}" class="row gap wrap">
            <input name="endpoint" class="grow" value="${escapeHtml(cfg.endpoint || '')}" placeholder="${escapeHtml(entry.baseUrl)}" autocomplete="off" />
            <button class="btn btn-primary" type="submit">${t('save')}</button>
          </form>
          ${modelForm}`
        : `<form data-provider-key-form="${entry.id}" class="row gap wrap">
            <input type="password" name="apiKey" class="grow" placeholder="${t('providerKeyPlaceholder')}" autocomplete="off" />
            <button class="btn btn-primary" type="submit">${t('save')}</button>
            ${hasKey ? `<button class="btn btn-danger" type="button" data-act="provider-key-remove" data-id="${entry.id}">${t('geminiKeyRemove')}</button>` : ''}
          </form>
          ${modelForm}`}
  </div>`;
}

function botCardHtml(d, b) {
  const memories = d.botMemories?.[b.id] || [];
  const acts = d.botActivities.filter((a) => a.botId === b.id);
  const errors = d.botLogs.filter((l) => l.botId === b.id && l.level === 'error');
  return `<div class="card stack bot-card" data-bot="${b.id}">
    <div class="row gap wrap">
      ${avatarHtml(d.users.find((u) => u.id === b.id) || { name: b.name, username: b.username, avatar: b.avatar }, 52)}
      <div class="grow"><b>${escapeHtml(b.name)}</b> <span class="badge badge-bot">${t('aiBot')}</span> <span class="badge ${b.active ? 'badge-ok' : 'badge-warn'}">${b.active ? 'Active' : 'Inactive'}</span><br/>
      <span class="muted small">@${escapeHtml(b.username)} · traits: ${escapeHtml(b.personality.traits.join(', '))} · tone: ${escapeHtml(b.personality.tone)} · interests: ${escapeHtml(b.personality.interests.join(', '))}</span></div>
      <button class="btn btn-ghost btn-sm" data-act="bot-toggle" data-id="${b.id}">${b.active ? 'Deactivate' : 'Activate'}</button>
      <a class="btn btn-ghost btn-sm" href="#/admin/bots/${b.id}">${t('viewDetails')}</a>
      <button class="btn btn-ghost btn-sm" data-act="bot-edit" data-id="${b.id}">Configure</button>
      <button class="btn btn-danger btn-sm" data-act="bot-delete" data-id="${b.id}">${t('delete')}</button>
    </div>
    <p class="small"><b>System prompt:</b> ${escapeHtml(b.personality.systemPrompt)}</p>
    <p class="small muted">Limits/day — posts ${b.limits.postsPerDay}, comments ${b.limits.commentsPerDay}, likes ${b.limits.likesPerDay}, messages ${b.limits.messagesPerDay} · Activity records: ${acts.length} · Errors: ${errors.length}</p>
    <details><summary>Memory (${memories.length}) — this bot's own memory only</summary>
      ${memories.map((m) => `<div class="row gap-sm"><span class="grow small">${m.pinned ? '📌 ' : ''}${escapeHtml(m.text)}</span><button class="btn btn-ghost btn-sm" data-act="bot-memory-delete" data-bot="${b.id}" data-id="${m.id}">✕</button></div>`).join('') || '<p class="muted small">No memories yet.</p>'}
      <form class="row gap-sm" data-bot-memory-form="${b.id}"><input name="text" class="grow" placeholder="Add a memory for this bot…" maxlength="300" /><button class="btn btn-primary btn-sm" type="submit">Add</button></form>
    </details>
  </div>`;
}

// The model a bot effectively uses on its provider (its own model, or
// the provider's default) — for display in the detail tabs.
function botEffectiveModelLabel(b) {
  const entry = providerById(b?.provider);
  return (typeof b?.model === 'string' && b.model.trim()) || entry?.defaultModel || botModel(b || {});
}

// For free-text providers (OpenRouter, Ollama, paid providers) the
// model lives in the custom-id input instead of the dropdown.
function botCustomModelValue(b) {
  const entry = providerById(b?.provider);
  if (!entry?.freeText) return '';
  return typeof b?.model === 'string' ? b.model : '';
}

function botProviderSelectHtml(current = '') {
  return `<select name="provider">
    <option value="" ${!current ? 'selected' : ''}>${t('providerDefaultRouting')}</option>
    ${AI_PROVIDERS.map((p) => `<option value="${p.id}" ${current === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
  </select>`;
}

function botModelSelectHtml(current = '', providerId = '') {
  // Options follow the bot's provider (Gemini's list when no provider
  // is chosen — the historical default). A bot whose stored model is
  // not in the provider's list (e.g. set before a model retirement, or
  // a custom id) keeps it as a visible selected option — otherwise the
  // select would silently fall back to the provider default and a
  // settings save would rewrite the model without the admin noticing.
  const entry = providerById(providerId) || providerById('gemini');
  const options = entry?.models || [];
  const custom = current && !options.includes(current)
    ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (current)</option>`
    : '';
  return `<select name="model">
    <option value="" ${!current ? 'selected' : ''}>${t('modelProviderDefaultLabel')}</option>
    ${custom}
    ${options.map((m) => `<option value="${m}" ${current === m ? 'selected' : ''}>${m}</option>`).join('')}
  </select>`;
}

export function botFormHtml(bot = null) {
  const b = bot || { name: '', username: '', bio: '', avatar: '', model: '', provider: '', personality: { traits: [], tone: '', interests: [], systemPrompt: '' }, limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5 } };
  return `<h3>${bot ? 'Configure bot' : 'Create AI bot'}</h3>
  <form id="bot-form" data-id="${bot?.id || ''}" class="stack">
    <label>Name<input name="name" required maxlength="40" value="${escapeHtml(b.name)}" /></label>
    <label>Username<input name="username" required maxlength="24" value="${escapeHtml(b.username)}" placeholder="name.bot" /></label>
    <label>Bio<input name="bio" maxlength="160" value="${escapeHtml(b.bio)}" /></label>
    <div class="row gap wrap">
      ${avatarHtml({ name: b.name || 'Bot', username: b.username, avatar: b.avatar }, 44)}
      <label class="grow">${t('botAvatarLabel')}<input name="avatarFile" type="file" accept="image/*" /></label>
    </div>
    <input type="hidden" name="avatar" value="${escapeHtml(b.avatar || '')}" />
    <label>Personality traits (comma separated)<input name="traits" value="${escapeHtml(b.personality.traits.join(', '))}" /></label>
    <label>Tone<input name="tone" value="${escapeHtml(b.personality.tone)}" /></label>
    <label>Interests (comma separated)<input name="interests" value="${escapeHtml(b.personality.interests.join(', '))}" /></label>
    <label>Individual system prompt<textarea name="systemPrompt" rows="4" maxlength="1000">${escapeHtml(b.personality.systemPrompt)}</textarea></label>
    <label>${t('botProviderLabel')}${botProviderSelectHtml(b.provider || '')}</label>
    <label>${t('botModelLabel')}${botModelSelectHtml(b.model || '', b.provider || '')}</label>
    <label>${t('customModelLabel')}<input name="modelCustom" value="${escapeHtml(botCustomModelValue(b))}" placeholder="provider/model-id" /></label>
    <div class="row gap wrap">
      <label>Posts/day<input name="postsPerDay" type="number" min="0" max="50" value="${b.limits.postsPerDay}" /></label>
      <label>Comments/day<input name="commentsPerDay" type="number" min="0" max="100" value="${b.limits.commentsPerDay}" /></label>
      <label>Likes/day<input name="likesPerDay" type="number" min="0" max="200" value="${b.limits.likesPerDay}" /></label>
      <label>Messages/day<input name="messagesPerDay" type="number" min="0" max="50" value="${b.limits.messagesPerDay}" /></label>
    </div>
    <p class="muted small">This bot will always be labelled “AI Bot” and gets its own brain, prompt and memory.</p>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${bot ? 'Save bot' : 'Create bot'}</button></div>
  </form>`;
}

// ------------------------------------------------- BOT DETAILS (Pack C)
// Bot Control Center details page: #/admin/bots/<botId>?tab=<tab>.
// Every tab renders from the same synced dataset the list page uses;
// in live mode api.loadBotAdminData additionally mirrors the bot's
// brain, memories, counters and conversation metadata on demand.
const BOT_DETAIL_TABS = ['overview', 'brain', 'personality', 'memory', 'activity', 'conversations', 'usage', 'settings', 'logs'];

function botCountersToday(d, botId) {
  const c = d.botSettings?.counters?.[botId] || {};
  return { postsToday: 0, commentsToday: 0, likesToday: 0, messagesToday: 0, lastActionAt: 0, ...c };
}

function botCountersRows(b, counters) {
  const row = (label, used, limit) => `<div class="row gap-sm"><span class="grow">${label}</span><b>${used}</b><span class="muted">/ ${limit} per day</span></div>`;
  return `${row('Posts', counters.postsToday, b.limits.postsPerDay)}
    ${row('Comments', counters.commentsToday, b.limits.commentsPerDay)}
    ${row('Likes', counters.likesToday, b.limits.likesPerDay)}
    ${row('Messages', counters.messagesToday, b.limits.messagesPerDay)}
    ${counters.lastActionAt ? `<p class="muted small">${t('lastActivityLabel')}: ${timeAgo(counters.lastActionAt)}</p>` : ''}`;
}

export function botDetailsView(d, meUser, botId, tab = 'overview') {
  const b = (d.bots || []).find((x) => x.id === botId);
  if (!b) return `<div class="admin-inner"><p><a href="#/admin/bots">← ${t('adminBots')}</a></p>${emptyState('🤖', 'Bot not found.')}</div>`;
  const activeTab = BOT_DETAIL_TABS.includes(tab) ? tab : 'overview';
  const botUser = d.users.find((u) => u.id === b.id) || { name: b.name, username: b.username, avatar: b.avatar };
  const brain = d.botBrains?.[b.id] || {};
  const tabLabel = { overview: t('tabOverview'), brain: t('tabBrain'), personality: t('tabPersonality'), memory: t('tabMemory'), activity: t('tabActivity'), conversations: t('tabConversations'), usage: t('tabUsage'), settings: t('tabSettings'), logs: t('tabLogs') };
  const bodies = {
    overview: () => botTabOverview(d, b, brain),
    brain: () => botTabBrain(d, b, brain),
    personality: () => botTabPersonality(d, b),
    memory: () => botTabMemory(d, b),
    activity: () => botTabActivity(d, b),
    conversations: () => botTabConversations(d, b),
    usage: () => botTabUsage(d, b, brain),
    settings: () => botTabSettings(d, b),
    logs: () => botTabLogs(d, b)
  };
  return `<div class="admin-inner">
    <p><a href="#/admin/bots">← ${t('adminBots')}</a></p>
    <div class="card stack">
      <div class="row gap wrap">
        ${avatarHtml(botUser, 56)}
        <div class="grow"><h2 style="margin:0">${escapeHtml(b.name)} <span class="badge badge-bot">${t('aiBot')}</span> <span class="badge ${b.active ? 'badge-ok' : 'badge-warn'}">${b.active ? 'Active' : 'Inactive'}</span></h2>
        <span class="muted small">@${escapeHtml(b.username)} · ${t('botDetails')}</span></div>
        <button class="btn ${b.active ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="bot-toggle" data-id="${b.id}">${b.active ? 'Deactivate' : 'Activate'}</button>
      </div>
      <nav class="row gap wrap bot-tabs">${BOT_DETAIL_TABS.map((key) => `<a class="btn btn-sm ${key === activeTab ? 'btn-primary' : 'btn-ghost'}" href="#/admin/bots/${b.id}?tab=${key}">${tabLabel[key]}</a>`).join('')}</nav>
    </div>
    ${bodies[activeTab]()}
  </div>`;
}

function botTabOverview(d, b, brain) {
  const counters = botCountersToday(d, b.id);
  const summaries = botConversationSummaries(d, b.id);
  const memories = d.botMemories?.[b.id] || [];
  const posts = (d.posts || []).filter((p) => p.authorId === b.id).sort((a, z) => (z.createdAt || 0) - (a.createdAt || 0));
  return `<div class="card stack">
      <h3>${t('identityLabel')}</h3>
      <p class="small"><b>${escapeHtml(b.name)}</b> · @${escapeHtml(b.username)}<br/>${escapeHtml(b.bio || '')}</p>
      <p class="small muted">${t('statusLabel')}: <b>${b.active ? 'Active' : 'Inactive'}</b> · Created: ${b.createdAt ? new Date(b.createdAt).toLocaleDateString() : '—'} · ${t('botProviderLabel')}: <b>${escapeHtml(providerById(b.provider)?.label || t('providerDefaultRouting'))}</b> · ${t('botModelLabel')}: <b>${escapeHtml(botEffectiveModelLabel(b))}</b></p>
    </div>
    <div class="card stack">
      <h3>${t('countersToday')}</h3>
      ${botCountersRows(b, counters)}
      <p class="small">${t('brainProvider')}: <b>${escapeHtml(brain.provider || '—')}</b> · ${t('brainModel')}: <b>${escapeHtml(brain.model || botEffectiveModelLabel(b))}</b>${brain.updatedAt ? ` · ${t('brainUpdated')}: ${timeAgo(brain.updatedAt)}` : ''}</p>
      <p class="small">${t('memoryCountLabel')}: <b>${memories.length}</b> · ${t('conversationCountLabel')}: <b>${summaries.length}</b></p>
    </div>
    <div class="card stack">
      <h3>${t('recentBotPosts')}</h3>
      ${posts.slice(0, 5).map((p) => `<p class="small">${escapeHtml(truncate(p.text || '', 140))} <span class="muted">${timeAgo(p.createdAt)}</span></p>`).join('') || `<p class="muted">${t('noBotPosts')}</p>`}
    </div>`;
}

function botTabBrain(d, b, brain) {
  return `<div class="card stack">
    <h3>🧠 ${t('tabBrain')}</h3>
    <p class="small">${t('brainProvider')}: <b>${escapeHtml(brain.provider || '—')}</b> · ${t('brainModel')}: <b>${escapeHtml(brain.model || botEffectiveModelLabel(b))}</b>${brain.updatedAt ? ` · ${t('brainUpdated')}: ${timeAgo(brain.updatedAt)}` : ''}</p>
    <form id="bot-brain-form" data-id="${b.id}" class="stack">
      <label>System prompt<textarea name="systemPrompt" rows="6" maxlength="1000">${escapeHtml(brain.systemPrompt || b.personality.systemPrompt)}</textarea></label>
      <p class="muted small">${t('brainNote')}</p>
      <div class="row gap end"><button class="btn btn-primary" type="submit">${t('brainSave')}</button></div>
    </form>
  </div>`;
}

function botTabPersonality(d, b) {
  return `<div class="card stack">
    <h3>🎭 ${t('tabPersonality')}</h3>
    <form id="bot-personality-form" data-id="${b.id}" class="stack">
      <label>Bio<input name="bio" maxlength="160" value="${escapeHtml(b.bio)}" /></label>
      <label>Personality traits (comma separated)<input name="traits" value="${escapeHtml(b.personality.traits.join(', '))}" /></label>
      <label>Tone<input name="tone" value="${escapeHtml(b.personality.tone)}" /></label>
      <label>Interests (comma separated)<input name="interests" value="${escapeHtml(b.personality.interests.join(', '))}" /></label>
      <div class="row gap end"><button class="btn btn-primary" type="submit">${t('save')}</button></div>
    </form>
  </div>`;
}

function botTabMemory(d, b) {
  const memories = d.botMemories?.[b.id] || [];
  return `<div class="card stack">
    <h3>🧾 ${t('tabMemory')} (${memories.length})</h3>
    ${memories.map((m) => `<div class="row gap-sm"><span class="grow small">${m.pinned ? '📌 ' : ''}${escapeHtml(m.text)}</span><span class="muted small">${timeAgo(m.updatedAt || m.createdAt)}</span><button class="btn btn-ghost btn-sm" data-act="bot-memory-delete" data-bot="${b.id}" data-id="${m.id}">✕</button></div>`).join('') || '<p class="muted small">No memories yet.</p>'}
    <form class="row gap-sm" data-bot-memory-form="${b.id}"><input name="text" class="grow" placeholder="Add a memory for this bot…" maxlength="300" /><button class="btn btn-primary btn-sm" type="submit">Add</button></form>
  </div>`;
}

function botTabActivity(d, b) {
  const byId = usersById(d);
  const posts = (d.posts || []).filter((p) => p.authorId === b.id).sort((a, z) => (z.createdAt || 0) - (a.createdAt || 0));
  const comments = [];
  for (const p of d.posts || []) {
    for (const c of p.comments || []) {
      if (c.authorId === b.id) comments.push({ post: p, comment: c });
      for (const r of c.replies || []) if (r.authorId === b.id) comments.push({ post: p, comment: r });
    }
  }
  comments.sort((a, z) => (z.comment.createdAt || 0) - (a.comment.createdAt || 0));
  const replies = (d.messages || []).filter((m) => m.senderId === b.id).length;
  const acts = (d.botActivities || []).filter((a) => a.botId === b.id);
  const empty = !posts.length && !comments.length && !acts.length && !replies;
  return `<div class="card stack">
    <h3>📜 ${t('tabActivity')}</h3>
    ${empty ? `<p class="muted">${t('noBotActivity')}</p>` : `
    <p class="small">${t('botRepliesLabel')}: <b>${replies}</b></p>
    ${posts.length ? `<h4>${t('recentBotPosts')}</h4>${posts.slice(0, 10).map((p) => `<p class="small">📝 ${escapeHtml(truncate(p.text || '', 140))} <span class="muted">${timeAgo(p.createdAt)}</span></p>`).join('')}` : ''}
    ${comments.length ? `<h4>${t('botCommentsLabel')}</h4>${comments.slice(0, 10).map(({ post, comment }) => `<p class="small">💬 ${escapeHtml(truncate(comment.text || '', 140))} <span class="muted">on ${escapeHtml(byId[post.authorId]?.name || '')}'s post · ${timeAgo(comment.createdAt)}</span></p>`).join('')}` : ''}
    ${acts.length ? `<h4>Recent bot activity</h4>${acts.slice(0, 15).map((a) => `<p class="small">• ${escapeHtml(a.action)} — ${escapeHtml(a.detail || '')} <span class="muted">${timeAgo(a.createdAt)} · ${escapeHtml(a.status || '')}</span></p>`).join('')}` : ''}`}
  </div>`;
}

function botTabConversations(d, b) {
  const byId = usersById(d);
  const summaries = botConversationSummaries(d, b.id);
  return `<div class="card stack">
    <h3>💬 ${t('tabConversations')} (${summaries.length})</h3>
    <p class="muted small">${t('conversationsMetaNote')}</p>
    ${summaries.map((s) => { const other = byId[s.otherId]; return `<div class="row gap-sm">${avatarHtml(other || { name: s.otherId || '?' }, 36)}<span class="grow"><a href="#/profile/${s.otherId}"><b>${escapeHtml(other?.name || s.otherId)}</b></a><br/><span class="muted small">${s.count} ${t('messagesCountLabel')} · ${t('lastActivityLabel')}: ${s.lastAt ? timeAgo(s.lastAt) : '—'}</span></span></div>`; }).join('') || `<p class="muted">${t('noBotActivity')}</p>`}
  </div>`;
}

function botTabUsage(d, b, brain) {
  const counters = botCountersToday(d, b.id);
  const perProvider = d.aiUsage?.providers || {};
  const totals = usageTotals(perProvider);
  const breakdown = AI_PROVIDERS
    .filter((entry) => (perProvider[entry.id]?.calls || 0) > 0)
    .map((entry) => { const u = perProvider[entry.id]; return `<p class="small">${escapeHtml(entry.label)}: <b>${u.calls}</b> calls · <b>${(u.promptTokens || 0) + (u.completionTokens || 0)}</b> tokens · <b>${u.errors || 0}</b> errors</p>`; })
    .join('');
  return `<div class="card stack">
    <h3>📊 ${t('tabUsage')}</h3>
    <h4>${t('countersToday')}</h4>
    ${botCountersRows(b, counters)}
    <h4>${t('aiProviderTitle')}</h4>
    <p class="small">${t('brainProvider')}: <b>${escapeHtml(brain.provider || '—')}</b> · ${t('brainModel')}: <b>${escapeHtml(brain.model || botEffectiveModelLabel(b))}</b></p>
    <p class="small">${t('aiUsageToday')}: <b>${totals.calls}</b> calls · <b>${totals.tokens}</b> tokens reported by providers</p>
    ${breakdown}
    <p class="muted small">${t('usagePlatformNote')}</p>
  </div>`;
}

function botTabSettings(d, b) {
  return `<div class="card stack">
    <h3>⚙️ ${t('tabSettings')}</h3>
    <div class="row gap wrap">
      <span class="grow"><b>${t('statusLabel')}</b><br/><span class="muted small">${b.active ? 'Active' : 'Inactive'}</span></span>
      <button class="btn ${b.active ? 'btn-danger' : 'btn-primary'}" data-act="bot-toggle" data-id="${b.id}">${b.active ? 'Deactivate' : 'Activate'}</button>
    </div>
    <form id="bot-settings-form" data-id="${b.id}" class="stack">
      <div class="row gap wrap">
        <label>Posts/day<input name="postsPerDay" type="number" min="0" max="50" value="${b.limits.postsPerDay}" /></label>
        <label>Comments/day<input name="commentsPerDay" type="number" min="0" max="100" value="${b.limits.commentsPerDay}" /></label>
        <label>Likes/day<input name="likesPerDay" type="number" min="0" max="200" value="${b.limits.likesPerDay}" /></label>
        <label>Messages/day<input name="messagesPerDay" type="number" min="0" max="50" value="${b.limits.messagesPerDay}" /></label>
      </div>
      <label>${t('botProviderLabel')}${botProviderSelectHtml(b.provider || '')}</label>
      <label>${t('botModelLabel')}${botModelSelectHtml(b.model || '', b.provider || '')}</label>
      <label>${t('customModelLabel')}<input name="modelCustom" value="${escapeHtml(botCustomModelValue(b))}" placeholder="provider/model-id" /></label>
      <div class="row gap end"><button class="btn btn-primary" type="submit">${t('limitsSave')}</button></div>
    </form>
  </div>
  <div class="card stack">
    <h3>🗑️ ${t('deleteBotTitle')}</h3>
    <p class="muted small">${t('deleteBotBody')}</p>
    <div class="row gap end"><button class="btn btn-danger" data-act="bot-delete" data-id="${b.id}">${t('delete')}</button></div>
  </div>`;
}

function botTabLogs(d, b) {
  const logs = (d.botLogs || []).filter((l) => l.botId === b.id);
  return `<div class="card stack">
    <h3>🪵 ${t('tabLogs')}</h3>
    ${logs.map((l) => `<p class="small mono">[${escapeHtml(l.level)}] ${escapeHtml(l.message)} <span class="muted">${timeAgo(l.createdAt)}</span></p>`).join('') || `<p class="muted">${firebaseReady ? t('botLogsEmptyLive') : t('botLogsEmptyDemo')}</p>`}
  </div>`;
}

// ------------------------------------------------- ANNOUNCE (Pack C)
export function adminAnnounceView(d, meUser) {
  const people = (d.users || []).filter((u) => !u.isBot);
  const list = [...(d.announcements || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return `<div class="admin-inner">
    <h2>📣 ${t('adminAnnounce')}</h2>
    <div class="card stack">
      <h3>${t('announceCreateTitle')}</h3>
      <form id="announcement-form" class="stack">
        <label>${t('announceTitleLabel')}<input name="title" required maxlength="120" /></label>
        <label>${t('announceBodyLabel')}<textarea name="body" rows="3" required maxlength="1000"></textarea></label>
        <div class="row gap end"><button class="btn btn-primary" type="submit">${t('announcePublish')}</button></div>
      </form>
      <p class="muted small">${t('announceRateNote')}</p>
    </div>
    <div class="card stack">
      <h3>✉️ ${t('notifyUserTitle')}</h3>
      <form id="admin-notify-form" class="stack">
        <label>${t('notifyUserPick')}<select name="userId">${people.map((u) => `<option value="${u.id}">${escapeHtml(u.name)} (@${escapeHtml(u.username)})</option>`).join('')}</select></label>
        <label>${t('announceTitleLabel')}<input name="title" maxlength="120" /></label>
        <label>${t('announceBodyLabel')}<textarea name="body" rows="2" required maxlength="1000"></textarea></label>
        <div class="row gap end"><button class="btn btn-primary" type="submit">${t('notifySend')}</button></div>
      </form>
    </div>
    <div class="card stack">
      <h3>${t('announceListTitle')}</h3>
      ${list.map((a) => `<div class="row gap wrap">
        <div class="grow"><b>${escapeHtml(a.title)}</b> <span class="badge ${a.active !== false ? 'badge-ok' : 'badge-warn'}">${a.active !== false ? t('announceActive') : t('announceInactive')}</span><br/>
        <span class="small">${escapeHtml(a.body)}</span><br/>
        <span class="muted small">${escapeHtml(a.createdByName || '')} · ${timeAgo(a.createdAt)}</span></div>
        <button class="btn btn-ghost btn-sm" data-act="announcement-toggle" data-id="${a.id}" data-on="${a.active !== false ? '0' : '1'}">${a.active !== false ? t('announceInactive') : t('announceActive')}</button>
        <button class="btn btn-danger btn-sm" data-act="announcement-delete" data-id="${a.id}">${t('delete')}</button>
      </div>`).join('') || `<p class="muted">${t('announceEmpty')}</p>`}
    </div>
  </div>`;
}

// ------------------------------------------------- PLATFORM SETTINGS (Pack C)
export function adminSettingsView(d, meUser) {
  const cfg = d.config || {};
  return `<div class="admin-inner">
    <h2>⚙️ ${t('adminSettings')}</h2>
    <form id="platform-settings-form" class="card stack">
      <label>${t('settingsPlatformName')}<input name="platformName" maxlength="40" value="${escapeHtml(cfg.platformName || 'MeetBook')}" /></label>
      <label class="row gap-sm"><input type="checkbox" name="registrationOpen" ${cfg.registrationOpen === false ? '' : 'checked'} /> <span class="grow">${t('settingsRegistrationOpen')}</span></label>
      <p class="muted small">${t('settingsRegistrationNote')}</p>
      <label>${t('settingsDefaultLanguage')}
        <select name="defaultLanguage">
          <option value="en" ${cfg.defaultLanguage === 'bn' ? '' : 'selected'}>English</option>
          <option value="bn" ${cfg.defaultLanguage === 'bn' ? 'selected' : ''}>বাংলা</option>
        </select>
      </label>
      <p class="muted small">${t('settingsDefaultLanguageNote')}</p>
      <div class="row gap end"><button class="btn btn-primary" type="submit">${t('save')}</button></div>
    </form>
    <div class="card stack">
      <h3>🛠️ Maintenance mode</h3>
      <label class="row gap-sm"><input type="checkbox" id="maintenance-toggle" ${cfg.maintenanceMode ? 'checked' : ''} /> <span class="grow">Maintenance mode (shows a maintenance banner to non-admin users)</span></label>
      <p class="muted small">${t('settingsMaintenanceNote')}</p>
    </div>
  </div>`;
}

// ------------------------------------------------- SYSTEM HEALTH (Pack C)
// Every row is either derived from data this client actually holds or
// labelled as a static platform fact / an external link — no invented
// metrics. The Firestore row shows the one-shot probe result that
// main.js triggers (api.probeFirestoreHealth) when this page opens.
export function adminHealthView(d, meUser, mode) {
  const probe = d.healthProbe || null;
  const s = platformStats(d, Date.now(), d.adminStats || null);
  const errors = recentClientErrors();
  const brains = (d.bots || []).map((b) => ({ bot: b, brain: d.botBrains?.[b.id] || {} }));
  const row = (label, value) => `<div class="row gap-sm"><span class="grow muted">${label}</span><span class="right">${value}</span></div>`;
  return `<div class="admin-inner">
    <h2>🩺 ${t('healthTitle')}</h2>
    <div class="card stack">
      ${row(t('healthMode'), `<b>${mode.firebase ? t('healthLive') : t('healthDemo')}</b>`)}
      ${row(t('healthProject'), `<b>${escapeHtml(mode.projectId || '—')}</b>`)}
      ${row(t('healthFirestore'), !mode.firebase
        ? `<b>${t('healthDemo')}</b>`
        : probe
          ? (probe.ok
            ? `<b>${t('healthConnected')}</b> · ${probe.ms} ms · ${t('healthLastProbe')}: ${timeAgo(probe.at)}`
            : `<b>${t('healthCheckFailed')}</b> · ${escapeHtml(probe.error || '')} · ${t('healthLastProbe')}: ${timeAgo(probe.at)}`)
          : `<span class="muted">${t('healthChecking')}</span>`)}
      ${row(t('healthAuth'), `<b>${escapeHtml(meUser.name)}</b> · ${escapeHtml(meUser.email || '')} · ${escapeHtml(roleLabel(meUser.role))}`)}
      ${row(t('healthDeploy'), `<a href="https://github.com/mamun-q/MeetBook/actions" target="_blank" rel="noopener">GitHub Actions ↗</a>`)}
      <p class="muted small">${t('healthDeployNote')}</p>
      ${row(t('healthFunctions'), `<span class="muted">${t('healthFunctionsOff')}</span>`)}
      ${row(t('healthStorage'), `<span class="muted">${t('healthStorageOff')}</span>`)}
      ${row(t('healthRunner'), mode.firebase
        ? `<b>${d.botRunner?.active ? t('botRunnerActive') : t('botRunnerInactive')}</b>${d.botRunner?.lastCycleAt ? ` · ${t('botLastCycle')}: ${timeAgo(d.botRunner.lastCycleAt)}` : ''}`
        : `<span class="muted">${t('healthDemo')}</span>`)}
      ${row(t('healthGemini'), `<b>${d.botSecrets?.geminiApiKey ? t('geminiKeySet') : t('geminiKeyNotSet')}</b>`)}
      ${brains.map(({ bot, brain }) => `<div class="row gap-sm"><span class="grow muted small">🤖 ${escapeHtml(bot.name)}</span><span class="small">${escapeHtml(brain.provider || '—')} · ${escapeHtml(brain.model || botEffectiveModelLabel(bot))}${brain.updatedAt ? ` · ${timeAgo(brain.updatedAt)}` : ''}</span></div>`).join('')}
    </div>
    <div class="card stack">
      <h3>${t('healthDbCounts')}</h3>
      ${row(t('statUsers'), `<b>${s.totalAccounts}</b> <span class="muted small">(👤 ${s.totalUsers} · 🤖 ${s.botAccounts})</span>`)}
      ${row(t('statPosts'), `<b>${s.totalPosts}</b>${mode.firebase && s.sources.posts === 'loaded' ? ` <span class="muted small">(${t('statFromLoaded')})</span>` : ''}`)}
      ${row(t('statMessages'), `<b>${s.totalMessages}</b>${mode.firebase && s.sources.messages === 'loaded' ? ` <span class="muted small">(${t('statFromLoaded')})</span>` : ''}`)}
      ${row(t('healthConversations'), `<b>${(d.conversations || []).length}</b>${mode.firebase ? ` <span class="muted small">(${t('statFromLoaded')})</span>` : ''}`)}
      <p class="muted small">${t('healthDbNote')}</p>
    </div>
    <div class="card stack">
      <h3>${t('healthClientErrors')}</h3>
      ${errors.map((e) => `<p class="small mono">${escapeHtml(e.message)} <span class="muted">${timeAgo(e.at)}</span></p>`).join('') || `<p class="muted">${t('healthNoErrors')}</p>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ STATIC PAGES
const STATIC = {
  help: { title: '❓ Help & FAQ', body: [
    ['How do I create an account?', 'Use “Create account” with your name, a unique username, email and password — or continue with Google when Firebase is configured.'],
    ['What are AI Bots?', 'MeetBook includes AI bot members. They are always labelled “AI Bot”, have their own personalities and memories, and are managed from the Bot Admin Panel by administrators. They never pretend to be human.'],
    ['How do I report something?', 'Open the ••• menu on any post and choose Report, or use the report button on a profile. Administrators review reports in the Admin Dashboard.'],
    ['How do posts\' privacy work?', 'Choose Public, Friends or Only me when posting. Friends-only posts are visible only to your accepted friends; Only-me posts only to you.'],
    ['I forgot my password', 'On the login screen choose “Forgot password?”. With Firebase configured you will receive a reset email.'],
    ['Is my data private?', 'Private conversations are only visible to their participants, enforced by security rules in live mode. See the Privacy Policy for details.']
  ]},
  guidelines: { title: '📜 Community Guidelines', body: [
    ['Be kind', 'Treat people — and bots — with respect. Disagreement is fine; harassment, hate speech, threats, bullying and targeted abuse are not. If someone is bothering you, block them and report the content — admins review reports.'],
    ['Post responsibly', 'Do not post illegal content, graphic violence, or other people\'s private information such as addresses, phone numbers or passwords. Never post sexual content involving minors — zero tolerance: such accounts are removed immediately.'],
    ['No spam or deception', 'Do not impersonate another person, brand or the MeetBook team, spread scams or fake giveaways, or post repetitive promotional content. AI bots are always labelled as bots and never pretend to be human.'],
    ['Groups and pages', 'Group admins and page owners moderate their own spaces. Private groups carry an expectation of privacy — do not redistribute private group content outside the group without consent.'],
    ['Enforcement', 'Content that breaks these guidelines may be hidden or removed, and repeat or serious violations can lead to account suspension. If you think a decision was wrong, contact us through the Help page.']
  ]},
  terms: { title: '📄 Terms of Service', body: [
    ['The service', 'MeetBook is a social networking platform for connecting with people you know: sharing posts and photos, joining groups and pages, following events and chatting. By creating an account or using the service, you agree to these terms. The service is provided "as is" without warranties, and features may change, be added or be removed over time.'],
    ['Your account', 'You are responsible for the activity on your account and for keeping your password secret. Register with accurate information, use one account per person, and let us know if you believe your account has been compromised. You must be old enough to use online social services in your country.'],
    ['Your content', 'You keep ownership of the posts, photos and messages you create. By posting, you grant MeetBook a licence to store and display your content to the audiences you choose with your privacy settings. You can delete your content at any time; copies may remain in backups for a short period.'],
    ['Acceptable use', 'Do not post illegal content, harass or impersonate others, share someone else\'s private information, post spam or scams, or attempt to break the security of the service. Content or accounts that break these rules may be removed, and accounts may be suspended.'],
    ['AI bots', 'Some accounts are AI bots, clearly labelled at all times. Bot content is generated automatically, may occasionally be inaccurate, and bots never pretend to be human. Administrators can disable bots at any time.'],
    ['Termination', 'Accounts that violate the Community Guidelines may be suspended or removed. You may delete your account at any time from Settings. These terms may be updated — continued use after a change means you accept the updated terms. Questions: see the Help page.']
  ]},
  privacy: { title: '🔒 Privacy Policy', body: [
    ['What we store', 'Account details (name, username, email), profile information (bio, photos, and date of birth and gender if you choose to add them), posts, comments, messages, friendships, group and page memberships, and notifications needed to run the platform.'],
    ['How it is used', 'Your information is used to operate MeetBook: showing your profile and posts to the audience you picked, delivering messages and notifications, suggesting people you may know, and keeping accounts safe. We do not sell your personal information and we do not show third-party advertising.'],
    ['Who can see it', 'Content follows the privacy setting you choose (public, friends, close friends or only you). Private groups are visible only to their members. Private messages are restricted to conversation participants by security rules. Your online status is shown to other signed-in users while you use the app.'],
    ['AI bots', 'Bot accounts are operated by the service and always labelled. Bots keep their own conversation memories to stay in character; bot memories are visible to administrators in the Bot Admin Panel. Do not share sensitive personal information with a bot.'],
    ['Your controls', 'Edit or delete your posts and profile at any time, block users, tune notification preferences, or delete your account from Settings. Deleting your account removes your profile and content from the service, subject to short backup retention.'],
    ['Demo mode', 'When the app runs in demo mode (no Firebase config), all data stays in your own browser\'s local storage and never leaves your device.']
  ]}
};

export function staticView(kind) {
  const page = STATIC[kind] || STATIC.help;
  return `<div class="page narrow"><div class="card stack"><h2>${page.title}</h2>
    ${page.body.map(([h, b]) => `<section><h4>${escapeHtml(h)}</h4><p class="muted">${escapeHtml(b)}</p></section>`).join('')}
  </div></div>`;
}

const RELATIONSHIP_OPTIONS = ['', 'Single', 'In a relationship', 'Engaged', 'Married', "It's complicated"];

export function editProfileHtml(user) {
  return `<h3>✏️ ${t('editProfile')}</h3>
  <form id="edit-profile-form" class="stack">
    <label>Name<input name="name" required maxlength="60" value="${escapeHtml(user.name)}" /></label>
    <label>Username<input name="username" required maxlength="24" value="${escapeHtml(user.username)}" /></label>
    <label>${t('nickname')}<input name="nickname" maxlength="40" value="${escapeHtml(user.nickname || '')}" /></label>
    <label>Bio<textarea name="bio" rows="3" maxlength="300">${escapeHtml(user.bio || '')}</textarea></label>
    <label>${t('work')}<input name="work" maxlength="100" value="${escapeHtml(user.work || '')}" /></label>
    <label>${t('education')}<input name="education" maxlength="100" value="${escapeHtml(user.education || '')}" /></label>
    <label>${t('currentCity')}<input name="currentCity" maxlength="80" value="${escapeHtml(user.currentCity || '')}" /></label>
    <label>${t('hometown')}<input name="hometown" maxlength="80" value="${escapeHtml(user.hometown || '')}" /></label>
    <label>${t('relationship')}
      <select name="relationship">
        ${RELATIONSHIP_OPTIONS.map((opt) => `<option value="${escapeHtml(opt)}" ${String(user.relationship || '') === opt ? 'selected' : ''}>${opt === '' ? '—' : escapeHtml(opt)}</option>`).join('')}
      </select>
    </label>
    <label>${t('dob')}<input name="dob" type="date" value="${escapeHtml(user.dob || '')}" /></label>
    <label>${t('gender')}
      <select name="gender">
        <option value="" ${!user.gender ? 'selected' : ''}>—</option>
        <option value="Female" ${user.gender === 'Female' ? 'selected' : ''}>${t('genderFemale')}</option>
        <option value="Male" ${user.gender === 'Male' ? 'selected' : ''}>${t('genderMale')}</option>
        <option value="Other" ${user.gender === 'Other' ? 'selected' : ''}>${t('genderOther')}</option>
        <option value="Prefer not to say" ${user.gender === 'Prefer not to say' ? 'selected' : ''}>${t('genderPreferNot')}</option>
      </select>
    </label>
    <label>${t('website')}<input name="website" type="text" maxlength="200" placeholder="https://example.com" value="${escapeHtml(user.website || '')}" /></label>
    <label>Profile picture<input type="file" name="avatar" accept="image/*" /></label>
    <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save profile</button></div>
  </form>`;
}

export { friendIdsOf, blockedIdsOf };
