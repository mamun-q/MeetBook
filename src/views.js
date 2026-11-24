// HTML generators for every route. Pure string builders: they read the shared
// dataset (api.data()) and never touch the DOM directly — main.js renders
// and binds events centrally.
import { escapeHtml, timeAgo, canViewPost, canViewGroup, canViewGroupPost, isGroupMember, searchByName, truncate, paginate, groupStoriesByAuthor, canViewStory, storyBackgroundCss, STORY_BACKGROUNDS, memoriesFor, upcomingEvents, canViewEvent, averageRating, FEELINGS, plural, mutualFriendCount, isStaff, canModerate, isAdminRole, accountStatus, canManageUser, canChangeRole, ASSIGNABLE_ROLES, platformStats, analyticsSeries, spamSuspects, reportStatus, reportCategory, reportNeedsAttention, countPostComments, botConversationSummaries, recentClientErrors, collapseDuplicateNotifications, REPORT_CATEGORIES, REPORT_OUTCOMES, typingUserIds, reactionChips, pinnedMessages, messageSnippet, chatTheme, CHAT_THEMES, MESSAGE_REACTIONS, reviewText, isEmojiOnlyText, canEditMessage, isMessageVisibleTo, isConversationFlagged, STICKER_PACKS, REACTION_EMOJI_SET, chatPollTotal, nicknameFor, mapsUrl, isVanishExpired, isMutedNow, isMessageRequest, formatBytes, safeMediaUrl, safeCssImageUrl } from './utils.js';
import { botModel } from './gemini.js';
import { cldImg } from './cloudinary.js';
import { AI_PROVIDERS, providerById, resolveAiConfig, usageTotals } from './aiProviders.js';
import { t } from './i18n.js';
import { avatarHtml, userNameHtml, postCardHtml, emptyState, verifiedBadgeHtml, pageVerifiedBadgeHtml, isVerifiedUser } from './components.js';
import { icon, iconFill } from './icons.js';
import { friendIdsOf, blockedIdsOf } from './store.js';
import { firebaseReady } from './firebase.js';

// Transient per-session UI state that views need but which is not app
// data (main.js flips these; a re-render reads them).
export const uiState = { memoriesDismissed: false, convInfoFor: '', convFilter: 'all', msgMenuFor: '', convMenuFor: '' };

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
  return `<label>${t(labelKey)}<span class="pw-wrap"><input name="${name}" type="password" ${required ? 'required' : ''} ${minlength ? `minlength="${minlength}"` : ''} autocomplete="${autocomplete}" placeholder="${placeholder}" /><button type="button" class="pw-eye" data-act="toggle-pw" aria-label="${t('showPassword')}" title="${t('showPassword')}">${icon('eye')}</button></span></label>`;
}

export function authView(mode = 'login') {
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <img class="auth-logo" src="./icons/icon-192.png" alt="MeetBook logo" />
      <div class="logo-big">MeetBook</div>
      <p>${t('authTagline')}</p>
      <ul class="auth-feats">
        <li>${icon('newspaper')} ${t('authFeat1')}</li>
        <li>${icon('message-circle')} ${t('authFeat2')}</li>
        <li>${icon('bot')} ${t('authFeat3')}</li>
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
            <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">${icon('image')} ${t('photo')}</button>
            <label class="btn btn-ghost btn-sm">${icon('bar-chart')} ${t('addPoll')}<input type="checkbox" name="hasPoll" hidden /></label>
            <select name="visibility" class="select-sm" aria-label="Post privacy">
              <option value="public" ${defaultVis === 'public' ? 'selected' : ''}>${t('publicLabel')}</option>
              <option value="friends" ${defaultVis === 'friends' ? 'selected' : ''}>${t('friends')}</option>
              <option value="close" ${defaultVis === 'close' ? 'selected' : ''}>${t('closeFriends')}</option>
              <option value="only-me" ${defaultVis === 'only-me' ? 'selected' : ''}>${t('onlyMe')}</option>
            </select>
            <span class="spacer"></span>
            <button class="btn btn-primary" type="submit">${t('post')}</button>
          </div>
          <div id="poll-fields" class="stack hidden pf-form">
            <div id="poll-options-list" class="stack">
              ${[1, 2].map((i) => `<div class="row gap-sm poll-opt-row"><input name="pollOption" maxlength="60" placeholder="${t('pollOption')} ${i}" autocomplete="off" /></div>`).join('')}
            </div>
            <div class="row gap wrap">
              <button type="button" class="btn btn-ghost btn-sm" data-act="poll-add-option">${icon('plus')} ${t('addOption')}</button>
              <button type="button" class="btn btn-ghost btn-sm" data-act="poll-remove">${icon('x')} ${t('removePoll')}</button>
            </div>
          </div>
          <div class="row gap wrap">
            <label class="grow">${icon('map-pin')} ${t('checkIn')}<input name="location" maxlength="120" placeholder="e.g. Lalbagh Fort, Dhaka" autocomplete="off" /></label>
            <label>${icon('smile')} ${t('feeling')}
              <select name="feeling" class="select-sm">
                <option value="">—</option>
                ${FEELINGS.map((f) => `<option value="${f.key}">${f.emoji} ${f.labelKey ? t(f.labelKey) : f.label}</option>`).join('')}
              </select>
            </label>
          </div>
        </form>
      </div>
      <div id="feed-list">
        ${pg.items.map((p) => postCardHtml(p, ctx)).join('') || emptyState('newspaper', t('noPosts'))}
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
      <span aria-hidden="true">${icon('megaphone')}</span>
      <div class="grow"><b>${escapeHtml(a.title)}</b>
        <p class="small">${escapeHtml(a.body)}</p>
        <span class="muted small">${escapeHtml(a.createdByName || '')} · ${timeAgo(a.createdAt)}</span>
      </div>
      <button class="icon-btn" data-act="dismiss-announcement" data-id="${escapeHtml(a.id)}" aria-label="${t('announceDismiss')}" title="${t('announceDismiss')}">${icon('x')}</button>
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
      <h3 class="grow">${icon('history')} ${t('memories')} · ${t('onThisDay')}</h3>
      <button class="icon-btn" data-act="dismiss-memories" aria-label="Dismiss">${icon('x')}</button>
    </div>
    ${memories.map(({ post, yearsAgo }) => `<a class="memory-item" href="#/profile/${escapeHtml(meUser.id)}">
      <span class="memory-when">${yearsAgo} ${yearsAgo === 1 ? t('yearAgo') : t('yearsAgo')}</span>
      <span class="memory-text">${post.text ? escapeHtml(truncate(post.text, 160)) : (post.image ? `${icon('camera', 'ic-sm')} Photo` : '')}</span>
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
    <h2>${icon('history')} ${t('memories')}</h2>
    <p class="muted">${t('onThisDay')}</p>
    ${memories.length ? memories.map(({ post, yearsAgo }) => `
      <p class="memory-when-label muted"><b>${yearsAgo} ${yearsAgo === 1 ? t('yearAgo') : t('yearsAgo')}</b></p>
      ${postCardHtml(post, ctx)}`).join('') : emptyState('history', t('memoriesEmpty'))}
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
    return `<button class="story-tile ${unviewed ? 'unviewed' : 'viewed'}" style="${bg}" data-act="view-story" data-author="${escapeHtml(g.authorId)}" aria-label="${escapeHtml(author.name)} — ${t('stories')}">
      ${latest.image ? `<img class="story-tile-img" src="${escapeHtml(safeMediaUrl(cldImg(latest.image, 480)))}" alt="" loading="lazy" decoding="async" />` : ''}
      <span class="story-tile-avatar">${avatarHtml(author, 34)}</span>
      <span class="story-tile-name">${escapeHtml(author.name.split(' ')[0])}</span>
    </button>`;
  };
  return `<div class="stories card">
    <button class="story-tile create" data-act="create-story" aria-label="${t('createStory')}">
      <span class="story-tile-avatar">${avatarHtml(meUser, 34)}</span>
      <span class="story-plus">${icon('plus')}</span>
      <span class="story-tile-name">${t('createStory')}</span>
    </button>
    ${groups.map(tile).join('')}
    ${groups.length === 0 ? `<p class="muted small story-empty">${t('noStories')}</p>` : ''}
  </div>`;
}

export function storyFormHtml() {
  return `<h3>${icon('plus')} ${t('createStory')}</h3>
  <form id="story-form" class="stack pf-form">
    <label>${t('storyText')}<textarea name="text" rows="3" maxlength="300" placeholder="${t('storyTextPlaceholder')}"></textarea></label>
    <label>${icon('camera')} Photo<input type="file" name="image" accept="image/*" /></label>
    <div>
      <span class="small muted">${t('storyBackground')}</span>
      <div class="bg-swatches">
        ${STORY_BACKGROUNDS.map((b, i) => `<label class="bg-swatch" style="background:${b.css}" title="${b.key}"><input type="radio" name="bg" value="${b.key}" ${i === 0 ? 'checked' : ''} /><span class="sr-only">${b.key}</span></label>`).join('')}
      </div>
    </div>
    <label>${t('privacyLabel')}
      <select name="visibility">
        <option value="public">${t('publicLabel')}</option>
        <option value="friends">${t('friends')}</option>
      </select>
    </label>
    <p class="muted small">${t('stories')} · 24h</p>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('createStory')}</button></div>
  </form>`;
}

export function leftRail(d, meUser) {
  return `<div class="card rail">
    <a class="rail-item" href="#/profile/${escapeHtml(meUser.id)}">${avatarHtml(meUser, 36)}<span>${escapeHtml(meUser.name)}</span></a>
    <a class="rail-item" href="#/">${icon('newspaper')} Feed</a>
    <a class="rail-item" href="#/friends">${icon('users')} ${t('friends')}</a>
    <a class="rail-item" href="#/events">${icon('calendar')} ${t('events')}</a>
    <a class="rail-item" href="#/memories">${icon('history')} ${t('memories')}</a>
    <a class="rail-item" href="#/groups">${icon('users-round')} ${t('groups')}</a>
    <a class="rail-item" href="#/pages">${icon('flag')} ${t('pages')}</a>
    <a class="rail-item" href="#/messages">${icon('message-circle')} ${t('messages')}</a>
    <a class="rail-item" href="#/saved">${icon('bookmark')} ${t('saved')} posts</a>
    <a class="rail-item" href="#/notifications">${icon('bell')} ${t('notifications')}</a>
    ${isStaff(meUser) ? `<a class="rail-item" href="#/admin">${icon('shield')} ${t('admin')}</a>` : ''}${isAdminRole(meUser) ? `<a class="rail-item" href="#/admin/bots">${icon('bot')} ${t('bots')}</a>` : ''}
    <a class="rail-item" href="#/settings">${icon('settings')} ${t('settings')}</a>
    <a class="rail-item" href="#/help">${icon('help-circle')} ${t('help')}</a>
  </div>`;
}

export function rightRail(d, meUser) {
  const friendIds = friendIdsOfData(d, meUser.id);
  const pending = d.friendships.filter((f) => f.to === meUser.id && f.status === 'pending');
  const suggestions = suggestionsFor(d, meUser).slice(0, 4);
  const byId = usersById(d);
  return `<div class="card rail">
    ${pending.length ? `<h4>Friend requests</h4>${pending.map((f) => `<div class="row gap-sm rail-person">${avatarHtml(byId[f.from], 36)}<span class="grow">${escapeHtml(byId[f.from]?.name || '')}</span><button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${escapeHtml(f.id)}">Accept</button><button class="btn btn-ghost btn-sm" data-act="reject-request" data-id="${escapeHtml(f.id)}" aria-label="Reject">${icon('x')}</button></div>`).join('')}` : ''}
    <h4>People you may know</h4>
    ${suggestions.map((u) => { const mutual = mutualFriendCount(d.friendships, meUser.id, u.id); return `<div class="row gap-sm rail-person">${avatarHtml(u, 36)}<span class="grow"><a href="#/profile/${escapeHtml(u.id)}">${escapeHtml(u.name)}</a>${verifiedBadgeHtml(u)}${mutual > 0 ? `<br/><span class="muted small">${mutual} ${mutual === 1 ? t('mutualFriend') : t('mutualFriends')}</span>` : ''}</span><button class="btn btn-ghost btn-sm" data-act="send-request" data-id="${escapeHtml(u.id)}">${t('addFriend')}</button></div>`; }).join('') || '<p class="muted small">No suggestions right now.</p>'}
    <h4>Online</h4>
    ${d.users.filter((u) => u.id !== meUser.id && isFreshOnline(u)).slice(0, 6).map((u) => `<a class="row gap-sm rail-person" href="#/profile/${escapeHtml(u.id)}"><span class="online-dot"></span>${escapeHtml(u.name)}${verifiedBadgeHtml(u)}</a>`).join('') || '<p class="muted small">Nobody online.</p>'}
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
  if (!user) return emptyState('search', 'This profile could not be found.');
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
      <div class="cover" style="${user.cover ? `background-image:url('${escapeHtml(safeCssImageUrl(user.cover))}')` : ''}">
        ${isMe ? `<button class="btn btn-ghost btn-sm cover-edit-btn" data-act="edit-profile">${icon('camera')} ${user.cover ? t('changeCoverPhoto') : t('addCoverPhoto')}</button>` : ''}
      </div>
      <div class="profile-meta">
        ${avatarHtml(user, 110)}
        <div class="grow">
          <h2>${userNameHtml(user)}${user.nickname ? ` <span class="nickname">(${escapeHtml(user.nickname)})</span>` : ''}</h2>
          <p class="muted">@${escapeHtml(user.username)} · ${friendIds.size} friends · ${(user.followers || []).length} followers · <span class="${user.online ? 'online-text' : 'muted'}">${user.online ? '● ' + t('online') : t('offline')}</span></p>
          <p>${escapeHtml(user.bio || 'No bio yet.')}</p>
          ${isMe && !user.avatar ? `<button class="link-btn small" data-act="edit-profile">${icon('camera')} ${t('addProfilePhoto')}</button>` : ''}
        </div>
        <div class="row gap wrap">
          ${isMe ? `<button class="btn btn-primary" data-act="edit-profile">${icon('pencil')} ${t('editProfile')}</button>` : `
            ${blocked ? `<button class="btn btn-ghost" data-act="block" data-id="${escapeHtml(user.id)}">Unblock</button>` : `
              ${rel?.status === 'accepted' ? `<button class="btn btn-ghost" data-act="remove-friend" data-id="${escapeHtml(rel.id)}">${icon('check')} Friends</button>` : rel?.status === 'pending' && rel.from === meUser.id ? `<button class="btn btn-ghost" data-act="cancel-request" data-id="${escapeHtml(rel.id)}" title="${t('tapToCancel')}">${icon('check')} ${t('requestSent')}</button>` : rel?.status === 'pending' ? `<button class="btn btn-primary" data-act="accept-request" data-id="${escapeHtml(rel.id)}">Accept request</button>` : `<button class="btn btn-primary" data-act="send-request" data-id="${escapeHtml(user.id)}">${t('addFriend')}</button>`}
              <button class="btn ${following ? 'btn-ghost' : 'btn-primary'}" data-act="follow" data-id="${escapeHtml(user.id)}">${following ? t('following') : t('follow')}</button>
              <button class="btn btn-ghost" data-act="message-user" data-id="${escapeHtml(user.id)}">${icon('message-circle')} Message</button>
              <button class="btn btn-ghost" data-act="block" data-id="${escapeHtml(user.id)}">Block</button>
              <button class="btn btn-ghost" data-act="report-user" data-id="${escapeHtml(user.id)}">${icon('flag')} ${t('report')}</button>`}
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
          ? `<div class="photos-grid">${photoPosts.map((p) => `<img class="photos-thumb" src="${escapeHtml(safeMediaUrl(cldImg(p.image, 480)))}" alt="${escapeHtml(truncate(p.text || 'Photo', 60))}" loading="lazy" decoding="async" />`).join('')}</div>`
          : `<p class="muted small">${t('noPhotosYet')}</p>`}
      </div>`;
      // Friends strip: count + up to 9 friend avatars linking to profiles.
      const friendUsers = [...friendIds].map((id) => ctx.usersById[id]).filter(Boolean).slice(0, 9);
      const friendsStrip = `<div class="card strip-card">
        <h3>${t('friends')} (${friendIds.size})</h3>
        ${friendUsers.length
          ? `<div class="friends-strip">${friendUsers.map((u) => `<a class="friend-tile" href="#/profile/${escapeHtml(u.id)}">${avatarHtml(u, 52)}<span>${escapeHtml(u.name.split(' ')[0])}</span></a>`).join('')}</div>`
          : `<p class="muted small">${t('noFriendsYet')}</p>`}
      </div>`;
      const sideBits = intro + photosStrip + friendsStrip;
      const postsHtml = `<div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('file-text', 'No visible posts yet.')}
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
  if (user.work) items.push(`<div class="intro-row"><span class="intro-icon">${icon('briefcase')}</span><span>${t('worksAt')} <b>${escapeHtml(user.work)}</b></span></div>`);
  if (user.education) items.push(`<div class="intro-row"><span class="intro-icon">${icon('grad-cap')}</span><span>${t('studiedAt')} <b>${escapeHtml(user.education)}</b></span></div>`);
  if (user.currentCity) items.push(`<div class="intro-row"><span class="intro-icon">${icon('map-pin')}</span><span>${t('livesIn')} <b>${escapeHtml(user.currentCity)}</b></span></div>`);
  if (user.hometown) items.push(`<div class="intro-row"><span class="intro-icon">${icon('home')}</span><span>${t('fromPlace')} <b>${escapeHtml(user.hometown)}</b></span></div>`);
  if (user.relationship) items.push(`<div class="intro-row"><span class="intro-icon">${icon('heart')}</span><span>${escapeHtml(user.relationship)}</span></div>`);
  if (user.dob) {
    const dobDate = new Date(`${user.dob}T00:00:00`);
    const dobText = Number.isNaN(dobDate.getTime()) ? String(user.dob) : dobDate.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    items.push(`<div class="intro-row"><span class="intro-icon">${icon('cake')}</span><span>${t('birthday')}: <b>${escapeHtml(dobText)}</b></span></div>`);
  }
  if (user.gender) items.push(`<div class="intro-row"><span class="intro-icon">${icon('user')}</span><span>${t('gender')}: <b>${escapeHtml(user.gender)}</b></span></div>`);
  if (user.website) {
    const href = /^https?:\/\//i.test(user.website) ? user.website : `https://${user.website}`;
    items.push(`<div class="intro-row"><span class="intro-icon">${icon('link')}</span><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(user.website)}</a></div>`);
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
  const person = (u, actions, extra = '') => {
    // A friendship can outlive the other account (admin deletion):
    // rendering a card for a missing user used to throw and take the
    // whole Friends page down with it.
    if (!u) return '';
    return `<div class="card person-card">${avatarHtml(u, 56)}<a href="#/profile/${escapeHtml(u.id)}"><b>${escapeHtml(u.name)}</b></a>${verifiedBadgeHtml(u)}<span class="muted small">@${escapeHtml(u.username)}</span>${extra}<div class="row gap wrap center">${actions}</div></div>`;
  };
  return `<div class="page">
    <h2>${icon('users')} ${t('friends')}</h2>
    <h3>${t('requestsReceived')}</h3>
    ${incoming.length ? `<div class="grid-people">${incoming.map((f) => person(byId[f.from], `<button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${escapeHtml(f.id)}">Accept</button><button class="btn btn-ghost btn-sm" data-act="reject-request" data-id="${escapeHtml(f.id)}">Reject</button>`, mutualLine(byId[f.from]))).join('')}</div>` : `<p class="muted">${t('noRequestsReceived')}</p>`}
    <h3>${t('requestsSent')}</h3>
    ${outgoing.length ? `<div class="grid-people">${outgoing.map((f) => person(byId[f.to], `<button class="btn btn-ghost btn-sm" data-act="cancel-request" data-id="${escapeHtml(f.id)}">${t('cancelRequest')}</button>`)).join('')}</div>` : `<p class="muted">${t('noRequestsSent')}</p>`}
    <h3>${t('yourFriends')} (${friendIds.size})</h3>
    <div class="grid-people">${[...friendIds].map((id) => { const rel = d.friendships.find((f) => f.status === 'accepted' && ((f.from === meUser.id && f.to === id) || (f.to === meUser.id && f.from === id))); const isClose = (meUser.closeFriends || []).includes(id); return person(byId[id], `<button class="btn ${isClose ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="toggle-close-friend" data-id="${id}" title="${t('closeFriends')}">${isClose ? iconFill('star') : icon('star')} ${t('closeFriends')}</button><button class="btn btn-ghost btn-sm" data-act="message-user" data-id="${id}">Message</button><button class="btn btn-ghost btn-sm" data-act="remove-friend" data-id="${rel?.id}">Remove</button>`); }).join('') || '<p class="muted">No friends yet — send a request below.</p>'}</div>
    <h3>${t('suggestedForYou')}</h3>
    <div class="grid-people">${suggestions.map((u) => person(u, `<button class="btn btn-primary btn-sm" data-act="send-request" data-id="${escapeHtml(u.id)}">${t('addFriend')}</button>`, mutualLine(u))).join('') || '<p class="muted">No suggestions.</p>'}</div>
  </div>`;
}

// ------------------------------------------------------------------ GROUPS
// Member count for a group row: full rows count their members
// array; metadata-only discovery rows (private groups the viewer
// does not belong to) carry the server-computed memberCount
// instead — their members array is empty by design and must never
// be read as "0 members".
export const groupMemberCount = (g) => (g.metaOnly ? (g.memberCount || 0) : (g.members || []).length);

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
    <a href="#/group/${escapeHtml(g.id)}"><b>${escapeHtml(g.name)}</b></a>
    <span class="muted small">${g.privacy === 'private' ? icon('lock', 'ic-sm') + ' ' + t('privateLabel') : icon('globe', 'ic-sm') + ' ' + t('publicLabel')} · ${plural(groupMemberCount(g), t('member'), t('members'))}</span>
    <span class="muted small">${escapeHtml(truncate(g.description || '', 90))}</span>
    <div class="row gap wrap center">
      ${isGroupMember(g, meUser.id) ? `<span class="badge badge-ok">${t('joined')}</span>` : pendingReq ? `<span class="badge badge-warn">${t('requestPending')}</span>` : `<button class="btn btn-primary btn-sm" data-act="toggle-group-join" data-id="${escapeHtml(g.id)}">${g.privacy === 'private' ? t('requestToJoin') : t('joinGroup')}</button>`}
      <a class="btn btn-ghost btn-sm" href="#/group/${escapeHtml(g.id)}">View</a>
    </div>
  </div>`;
  };
  return `<div class="page">
    <div class="row"><h2 class="grow">${icon('users-round')} ${t('groups')}</h2><button class="btn btn-primary" data-act="create-group">+ ${t('createGroup')}</button></div>
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

export function groupView(d, meUser, groupId, opts = {}) {
  const group = (d.groups || []).find((g) => g.id === groupId);
  // While the first groups sync is still landing (opts.loading, fed
  // from api.groupsSyncPending), an unknown id is not yet a missing
  // group — the tier-2 slices may simply not have delivered it. Show
  // a loading state rather than a false "could not be found" that
  // flips away a moment later.
  if (!group) return opts.loading ? emptyState('users-round', 'Loading…') : emptyState('users-round', 'This group could not be found.');
  if (!canViewGroup(group, meUser.id)) {
    // Private group, not a member: show only the public metadata and the
    // join-request action — no posts, no member list.
    const pending = (d.groupRequests || []).find((r) => r.groupId === group.id && r.userId === meUser.id && r.status === 'pending');
    return `<div class="profile-wrap"><div class="card profile-head">
      <div class="cover" style="${group.cover ? `background-image:url('${escapeHtml(safeCssImageUrl(group.cover))}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: group.name, username: group.name, avatar: group.cover }, 110)}
        <div class="grow">
          <h2>${escapeHtml(group.name)}</h2>
          <p class="muted">${icon('lock')} ${t('privateLabel')} · ${plural(groupMemberCount(group), t('member'), t('members'))}</p>
          <p>${escapeHtml(group.description || '')}</p>
          <p class="muted small">${icon('lock', 'ic-sm')} ${t('privateGroupNotice')}</p>
        </div>
        <div class="row gap wrap">
          ${pending ? `<span class="badge badge-warn">${t('requestPending')}</span><button class="btn btn-ghost" data-act="toggle-group-join" data-id="${escapeHtml(group.id)}">${t('withdrawRequest')}</button>`
            : `<button class="btn btn-primary" data-act="toggle-group-join" data-id="${escapeHtml(group.id)}">${t('requestToJoin')}</button>`}
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
      <div class="cover" style="${group.cover ? `background-image:url('${escapeHtml(safeCssImageUrl(group.cover))}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: group.name, username: group.name, avatar: '' }, 110)}
        <div class="grow">
          <h2>${escapeHtml(group.name)}</h2>
          <p class="muted">${group.privacy === 'private' ? icon('lock', 'ic-sm') + ' ' + t('privateLabel') : icon('globe', 'ic-sm') + ' ' + t('publicLabel')} · ${plural((group.members || []).length, t('member'), t('members'))} · created by ${escapeHtml(byId[group.createdBy]?.name || '')}${verifiedBadgeHtml(byId[group.createdBy])}</p>
          <p class="muted small">${icon('users-round', 'ic-sm')} ${t('aboutThisGroup')}: ${group.privacy === 'private' ? icon('lock', 'ic-sm') + ' ' + t('privateLabel') : icon('globe', 'ic-sm') + ' ' + t('publicLabel')} · ${t('createdOn')} ${new Date(group.createdAt || Date.now()).toLocaleDateString()} · ${plural((group.members || []).length, t('member'), t('members'))}</p>
          <p>${escapeHtml(group.description || '')}</p>
        </div>
        <div class="row gap wrap">
          ${isCreator ? `<button class="btn btn-primary" data-act="edit-group" data-id="${escapeHtml(group.id)}">${icon('pencil')} ${t('edit')}</button><button class="btn btn-danger" data-act="delete-group" data-id="${escapeHtml(group.id)}">${t('delete')} group</button>`
            : member ? `<button class="btn btn-ghost" data-act="toggle-group-join" data-id="${escapeHtml(group.id)}">${t('leaveGroup')}</button>`
            : myPending ? `<span class="badge badge-warn">${t('requestPending')}</span><button class="btn btn-ghost" data-act="toggle-group-join" data-id="${escapeHtml(group.id)}">${t('withdrawRequest')}</button>`
            : `<button class="btn btn-primary" data-act="toggle-group-join" data-id="${escapeHtml(group.id)}">${group.privacy === 'private' ? t('requestToJoin') : t('joinGroup')}</button>`}
        </div>
      </div>
    </div>
    ${isCreator && pendingRequests.length ? `
    <div class="card stack">
      <h3>${icon('inbox')} ${t('joinRequests')} (${pendingRequests.length})</h3>
      ${pendingRequests.map((r) => { const u = byId[r.userId]; return u ? `<div class="row gap-sm">${avatarHtml(u, 36)}<a class="grow" href="#/profile/${escapeHtml(u.id)}">${escapeHtml(u.name)}</a>${verifiedBadgeHtml(u)}<button class="btn btn-primary btn-sm" data-act="approve-group-request" data-id="${escapeHtml(r.id)}">${t('approve')}</button><button class="btn btn-ghost btn-sm" data-act="reject-group-request" data-id="${escapeHtml(r.id)}">${t('reject')}</button></div>` : ''; }).join('')}
    </div>` : ''}
    ${member ? `
    <div class="card composer">
      <div class="row gap-sm">${avatarHtml(meUser, 40)}<span class="muted">${escapeHtml(meUser.name)}</span></div>
      <form id="group-composer-form" data-group="${escapeHtml(group.id)}" class="stack">
        <textarea name="text" rows="3" maxlength="2000" placeholder="${t('postToGroup')}"></textarea>
        <input type="file" name="image" accept="image/*" hidden />
        <div class="row gap wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">${icon('image')} ${t('photo')}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${t('post')}</button>
        </div>
      </form>
    </div>` : `<div class="card"><p class="muted">${t('joinToPost')}</p></div>`}
    <div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('file-text', t('noPosts'))}
    </div>
    <div class="card stack">
      <h3>${t('members')} (${(group.members || []).length})</h3>
      ${(group.members || []).map((id) => {
        const u = byId[id];
        if (!u) return '';
        return `<div class="row gap-sm">${avatarHtml(u, 36)}<a class="grow" href="#/profile/${escapeHtml(u.id)}">${escapeHtml(u.name)}</a>${verifiedBadgeHtml(u)}${id === group.createdBy ? ` <span class="badge badge-admin">${t('roleAdmin')}</span>` : ''}${isCreator && id !== group.createdBy ? `<button class="btn btn-ghost btn-sm" data-act="remove-member" data-group="${escapeHtml(group.id)}" data-id="${id}">Remove</button>` : ''}</div>`;
      }).join('')}
    </div>
  </div>`;
}

export function groupFormHtml(group = null) {
  return `<h3>${group ? `${t('edit')} group` : t('createGroup')}</h3>
  <form id="group-form" data-id="${group?.id || ''}" class="stack pf-form">
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--basic">${icon('users')}</span><h4>${t('basicInfo')}</h4></div>
      <label>${t('groupName')}<input name="name" required maxlength="80" value="${escapeHtml(group?.name || '')}" /></label>
      <label>${t('description')}<textarea name="description" rows="3" maxlength="500">${escapeHtml(group?.description || '')}</textarea></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--privacy">${icon('lock')}</span><h4>${t('privacyLabel')}</h4></div>
      <label>${t('privacyLabel')}
        <select name="privacy">
          <option value="public" ${group?.privacy !== 'private' ? 'selected' : ''}>${t('publicLabel')}</option>
          <option value="private" ${group?.privacy === 'private' ? 'selected' : ''}>${t('privateLabel')}</option>
        </select>
      </label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--photos">${icon('camera')}</span><h4>${t('photos')}</h4></div>
      <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    </section>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${group ? 'Save group' : t('createGroup')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ PAGES
export function pagesView(d, meUser, queryText = '') {
  const all = d.pages || [];
  const byId = usersById(d);
  const mine = searchByName(all.filter((p) => p.ownerId === meUser.id || (p.followers || []).includes(meUser.id)), queryText);
  const discover = searchByName(all.filter((p) => p.ownerId !== meUser.id && !(p.followers || []).includes(meUser.id)), queryText);
  const card = (p) => `<div class="card person-card">
    ${avatarHtml({ name: p.name, username: p.name, avatar: p.avatar }, 56)}
    <a href="#/page/${escapeHtml(p.id)}"><b>${escapeHtml(p.name)}</b></a>${pageVerifiedBadgeHtml(p, byId)}
    <span class="badge">${escapeHtml(p.category || t('pageLabel'))}</span>
    <span class="muted small">${plural((p.followers || []).length, t('follower'), t('followers'))}</span>
    <span class="muted small">${escapeHtml(truncate(p.about || '', 90))}</span>
    <div class="row gap wrap center">
      ${p.ownerId === meUser.id ? `<span class="badge badge-ok">Your page</span>` : (p.followers || []).includes(meUser.id) ? `<button class="btn btn-ghost btn-sm" data-act="follow-page" data-id="${escapeHtml(p.id)}">${t('following')}</button>` : `<button class="btn btn-primary btn-sm" data-act="follow-page" data-id="${escapeHtml(p.id)}">${t('follow')}</button>`}
      <a class="btn btn-ghost btn-sm" href="#/page/${escapeHtml(p.id)}">View</a>
    </div>
  </div>`;
  return `<div class="page">
    <div class="row"><h2 class="grow">${icon('flag')} ${t('pages')}</h2><button class="btn btn-primary" data-act="create-page">+ ${t('createPage')}</button></div>
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
  if (!page) return emptyState('flag', 'This page could not be found.');
  const ctx = viewCtx(d, meUser);
  const isOwner = page.ownerId === meUser.id;
  const following = (page.followers || []).includes(meUser.id);
  const posts = d.posts.filter((p) => p.pageId === page.id).sort((a, b) => b.createdAt - a.createdAt);
  const pageReviews = (d.reviews || []).filter((r) => r.pageId === page.id).sort((a, b) => b.createdAt - a.createdAt);
  const ratingSummary = averageRating(pageReviews);
  const myReview = pageReviews.find((r) => r.authorId === meUser.id);
  const stars = (n) => iconFill('star', 'ic-sm').repeat(Math.round(n)) + icon('star', 'ic-sm').repeat(5 - Math.round(n));
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${page.cover ? `background-image:url('${escapeHtml(safeCssImageUrl(page.cover))}')` : ''}"></div>
      <div class="profile-meta">
        ${avatarHtml({ name: page.name, username: page.name, avatar: page.avatar }, 110)}
        <div class="grow">
          <h2>${escapeHtml(page.name)}${pageVerifiedBadgeHtml(page, ctx.usersById)}</h2>
          <p class="muted">${escapeHtml(page.category || '')} · ${plural((page.followers || []).length, t('follower'), t('followers'))} · by ${escapeHtml(ctx.usersById[page.ownerId]?.name || '')}</p>
          <p>${escapeHtml(page.about || '')}</p>
        </div>
        <div class="row gap wrap">
          ${isOwner ? `<button class="btn btn-primary" data-act="edit-page" data-id="${escapeHtml(page.id)}">${icon('pencil')} ${t('edit')}</button><button class="btn btn-danger" data-act="delete-page" data-id="${escapeHtml(page.id)}">${t('delete')} page</button>`
            : `<button class="btn ${following ? 'btn-ghost' : 'btn-primary'}" data-act="follow-page" data-id="${escapeHtml(page.id)}">${following ? t('following') : t('follow')}</button>`}
        </div>
      </div>
    </div>
    ${isOwner ? `
    <div class="card composer">
      <div class="row gap-sm">${avatarHtml({ name: page.name, username: page.name, avatar: page.avatar }, 40)}<span class="muted">${escapeHtml(page.name)}${pageVerifiedBadgeHtml(page, ctx.usersById)}</span></div>
      <form id="page-composer-form" data-page="${escapeHtml(page.id)}" class="stack">
        <textarea name="text" rows="3" maxlength="2000" placeholder="${t('postAsPage')}"></textarea>
        <input type="file" name="image" accept="image/*" hidden />
        <div class="row gap wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-act="pick-photo">${icon('image')} ${t('photo')}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" type="submit">${t('post')}</button>
        </div>
      </form>
    </div>` : ''}
    <div class="profile-posts">
      ${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('file-text', t('noPosts'))}
    </div>
    <div class="card stack">
      <h3>${icon('star')} ${t('reviews')} ${ratingSummary.count ? `· <span class="stars">${stars(ratingSummary.average)}</span> ${ratingSummary.average} (${ratingSummary.count})` : ''}</h3>
      ${pageReviews.map((r) => { const a = ctx.usersById[r.authorId]; return `<div class="row gap-sm review-item">${avatarHtml(a, 36)}<div class="grow"><b>${escapeHtml(a?.name || '')}${verifiedBadgeHtml(a)}</b> <span class="stars">${stars(r.rating)}</span> <span class="muted small">· ${timeAgo(r.createdAt)}</span>${reviewText(r) ? `<br/>${escapeHtml(reviewText(r))}` : ''}</div>${r.authorId === meUser.id ? `<button class="btn btn-ghost btn-sm" data-act="delete-review" data-id="${escapeHtml(r.id)}" aria-label="${t('delete')}">${icon('trash')}</button>` : ''}</div>`; }).join('') || `<p class="muted">${t('noReviews')}</p>`}
      ${isOwner ? '' : `
      <form id="review-form" data-page="${escapeHtml(page.id)}" class="stack pf-form">
        <h4>${myReview ? t('yourReview') : t('writeReview')}</h4>
        <div class="star-picker" role="radiogroup" aria-label="${t('rating')}">
          ${[1, 2, 3, 4, 5].map((n) => `<label class="star-option"><input type="radio" name="rating" value="${n}" ${Number(myReview?.rating || 0) === n ? 'checked' : ''} required /><span>${n <= Number(myReview?.rating || 0) ? iconFill('star') : icon('star')}</span></label>`).join('')}
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
  <form id="page-form" data-id="${page?.id || ''}" class="stack pf-form">
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--basic">${icon('flag')}</span><h4>${t('basicInfo')}</h4></div>
      <label>Page name<input name="name" required maxlength="80" value="${escapeHtml(page?.name || '')}" /></label>
      <label>${t('category')}<input name="category" list="page-categories" maxlength="60" value="${escapeHtml(page?.category || '')}" placeholder="Community" /></label>
      <datalist id="page-categories">${PAGE_CATEGORIES.map((c) => `<option value="${c}"></option>`).join('')}</datalist>
      <label>${t('about')}<textarea name="about" rows="3" maxlength="500">${escapeHtml(page?.about || '')}</textarea></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--photos">${icon('camera')}</span><h4>${t('photos')}</h4></div>
      <label>Profile picture<input type="file" name="avatar" accept="image/*" /></label>
      <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    </section>
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
        <a href="#/event/${escapeHtml(e.id)}"><b>${escapeHtml(e.title)}</b></a>
        <div class="muted small">${icon('clock', 'ic-sm')} ${escapeHtml(when)}${e.location ? ` · ${icon('map-pin', 'ic-sm')} ${escapeHtml(e.location)}` : ''}</div>
        <div class="muted small">${e.visibility === 'friends' ? icon('users', 'ic-sm') + ' ' + t('friends') : icon('globe', 'ic-sm') + ' ' + t('publicLabel')} · ${plural((e.going || []).length, t('going'), t('going'))} · ${plural((e.interested || []).length, t('interested'), t('interested'))} · by ${escapeHtml(byId[e.createdBy]?.name || '')}</div>
      </div>
    </div>
    <div class="row gap wrap">
      <button class="btn ${going ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="rsvp" data-kind="going" data-id="${escapeHtml(e.id)}">${going ? icon('check') + ' ' : ''}${t('going')}</button>
      <button class="btn ${interested ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="rsvp" data-kind="interested" data-id="${escapeHtml(e.id)}">${interested ? iconFill('star') : icon('star')} ${t('interested')}</button>
      <a class="btn btn-ghost btn-sm" href="#/event/${escapeHtml(e.id)}">Details</a>
    </div>
  </div>`;
}

export function eventsView(d, meUser) {
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  const visible = upcomingEvents((d.events || []).filter((e) => canViewEvent(e, { viewerId: meUser.id, friendIds: ctx.friendIds, blockedIds: blocked })));
  return `<div class="page">
    <div class="row"><h2 class="grow">${icon('calendar')} ${t('events')}</h2><button class="btn btn-primary" data-act="create-event">+ ${t('createEvent')}</button></div>
    <h3>${t('upcomingEvents')} (${visible.length})</h3>
    ${visible.map((e) => eventCardHtml(d, meUser, e, ctx)).join('') || emptyState('calendar', t('noEvents'))}
  </div>`;
}

export function eventView(d, meUser, eventId) {
  const e = (d.events || []).find((x) => x.id === eventId);
  const ctx = viewCtx(d, meUser);
  const blocked = blockedIdsOfData(d, meUser.id);
  if (!e || !canViewEvent(e, { viewerId: meUser.id, friendIds: ctx.friendIds, blockedIds: blocked })) return emptyState('calendar', 'This event could not be found.');
  const byId = ctx.usersById;
  const isCreator = e.createdBy === meUser.id;
  const going = (e.going || []).includes(meUser.id);
  const interested = (e.interested || []).includes(meUser.id);
  const when = new Date(e.dateTime || 0).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const personList = (ids) => (ids || []).map((id) => byId[id] ? `<div class="row gap-sm">${avatarHtml(byId[id], 32)}<a href="#/profile/${id}">${escapeHtml(byId[id].name)}</a>${verifiedBadgeHtml(byId[id])}</div>` : '').join('') || '<p class="muted small">—</p>';
  return `<div class="profile-wrap">
    <div class="card profile-head">
      <div class="cover" style="${e.cover ? `background-image:url('${escapeHtml(safeCssImageUrl(e.cover))}')` : ''}"></div>
      <div class="profile-meta">
        ${eventDateBlock(e.dateTime)}
        <div class="grow">
          <h2>${escapeHtml(e.title)}</h2>
          <p class="muted">${icon('clock')} ${escapeHtml(when)}${e.location ? `<br/>${icon('map-pin')} ${escapeHtml(e.location)}` : ''}</p>
          <p class="muted small">${e.visibility === 'friends' ? icon('users', 'ic-sm') + ' ' + t('friends') : icon('globe', 'ic-sm') + ' ' + t('publicLabel')}</p>
          ${byId[e.createdBy] ? `<div class="row gap-sm host-row">${avatarHtml(byId[e.createdBy], 32)}<span>${t('hostedBy')} <a href="#/profile/${e.createdBy}"><b>${escapeHtml(byId[e.createdBy].name)}</b></a>${verifiedBadgeHtml(byId[e.createdBy])}</span></div>` : ''}
        </div>
        <div class="row gap wrap">
          ${isCreator ? `<button class="btn btn-danger" data-act="delete-event" data-id="${escapeHtml(e.id)}">${t('delete')} event</button>` : ''}
        </div>
      </div>
    </div>
    <div class="card stack">
      <div class="row gap wrap">
        <button class="btn ${going ? 'btn-primary' : 'btn-ghost'}" data-act="rsvp" data-kind="going" data-id="${escapeHtml(e.id)}">${going ? icon('check') + ' ' : ''}${t('going')} (${(e.going || []).length})</button>
        <button class="btn ${interested ? 'btn-primary' : 'btn-ghost'}" data-act="rsvp" data-kind="interested" data-id="${escapeHtml(e.id)}">${interested ? iconFill('star') : icon('star')} ${t('interested')} (${(e.interested || []).length})</button>
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
  return `<h3>${icon('calendar')} ${t('createEvent')}</h3>
  <form id="event-form" class="stack pf-form">
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--edu">${icon('calendar')}</span><h4>${t('basicInfo')}</h4></div>
      <label>${t('eventTitle')}<input name="title" required maxlength="120" /></label>
      <label>${t('description')}<textarea name="description" rows="3" maxlength="1000"></textarea></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--time">${icon('clock')}</span><h4>${t('whenAndWhere')}</h4></div>
      <label>${t('eventDate')}<input name="dateTime" type="datetime-local" required /></label>
      <label>${t('eventLocation')}<input name="location" maxlength="120" placeholder="e.g. TSC, University of Dhaka" /></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--photos">${icon('camera')}</span><h4>${t('photos')}</h4></div>
      <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--privacy">${icon('lock')}</span><h4>${t('privacyLabel')}</h4></div>
      <label>${t('privacyLabel')}
        <select name="visibility">
          <option value="public">${t('publicLabel')}</option>
          <option value="friends">${t('friends')}</option>
        </select>
      </label>
    </section>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${t('createEvent')}</button></div>
  </form>`;
}

// ------------------------------------------------------------------ MESSAGES
// Full invite URL for a group-chat join code. `location` only exists
// in the browser; in tests this degrades to the bare hash route.
export function inviteLinkFor(code) {
  const base = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
  return `${base}#/messages?join=${code}`;
}

export function messagesView(d, meUser, activeConvId = '') {
  const byId = usersById(d);
  const myFriendIds = friendIdsOfData(d, meUser.id);
  const myConvs = d.conversations.filter((c) => c.participants.includes(meUser.id))
    .map((c) => {
      const isGroup = Boolean(c.isGroup);
      const otherId = c.participants.find((p) => p !== meUser.id);
      const msgs = d.messages.filter((m) => m.conversationId === c.id && isMessageVisibleTo(m, meUser.id) && !isVanishExpired(m)).sort((a, b) => a.createdAt - b.createdAt);
      const last = msgs[msgs.length - 1];
      const unread = msgs.filter((m) => m.senderId !== meUser.id && !(m.readBy || []).includes(meUser.id)).length;
      const mentionUnread = msgs.some((m) => m.senderId !== meUser.id && !(m.readBy || []).includes(meUser.id) && (m.mentions || []).includes(meUser.id));
      const title = isGroup ? (c.title || t('groupChat')) : nicknameFor(c, otherId, byId[otherId]?.name || 'Unknown');
      const avatarUser = isGroup ? { name: title, username: title, avatar: c.photo || '' } : byId[otherId];
      let preview = 'Say hello';
      if (last?.unsent) preview = `🚫 ${t('messageUnsent')}`;
      else if (last) preview = last.audio && !last.text ? `🎤 ${t('voiceMessage')}` : last.sticker ? `🎨 ${t('sticker')}` : last.location ? `📍 ${t('sharedLocation')}` : last.poll ? `📊 ${t('poll')}: ${last.poll.question}` : last.file ? `📎 ${last.file.name || t('file')}` : (last.text || (last.image ? '📷 Photo' : 'Say hello'));
      if (isGroup && last && last.senderId !== meUser.id && !last.unsent) preview = `${nicknameFor(c, last.senderId, (byId[last.senderId]?.name || '').split(' ')[0])}: ${preview}`;
      const archived = isConversationFlagged(c, 'archivedBy', meUser.id);
      const muted = isMutedNow(c, meUser.id);
      const pinned = isConversationFlagged(c, 'pinnedBy', meUser.id);
      const request = isMessageRequest(c, meUser.id, myFriendIds, byId);
      return { conv: c, isGroup, other: byId[otherId], title, avatarUser, searchText: title.toLowerCase(), last, unread, mentionUnread, msgs, preview, archived, muted, pinned, request };
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.last?.createdAt || b.conv.createdAt) - (a.last?.createdAt || a.conv.createdAt));
  const active = myConvs.find((x) => x.conv.id === activeConvId) || myConvs.find((x) => !x.archived && !x.request) || myConvs.find((x) => !x.archived) || myConvs[0];
  // Conversation list filter: All / Unread / Requests / Archived chips.
  // Archived chats and unaccepted message requests each live in their
  // own list, like Messenger.
  const filter = uiState.convFilter || 'all';
  const listedConvs = myConvs.filter((x) => filter === 'archived' ? x.archived : filter === 'requests' ? (!x.archived && x.request) : filter === 'unread' ? (!x.archived && !x.request && x.unread > 0) : (!x.archived && !x.request));
  const archivedCount = myConvs.filter((x) => x.archived).length;
  const requestsCount = myConvs.filter((x) => x.request && !x.archived).length;
  // Active-now rail: people (and bots) currently online, friends first.
  const onlineUsers = d.users.filter((u) => u.id !== meUser.id && u.online)
    .sort((a, b) => Number(myFriendIds.has(b.id)) - Number(myFriendIds.has(a.id))).slice(0, 12);
  return `<div class="messenger card ${activeConvId ? 'has-open' : ''}">
    <div class="conv-list">
      <div class="row gap-sm"><h3 class="grow">${icon('message-circle')} ${t('messages')}</h3><button class="btn btn-primary btn-sm" data-act="create-group-chat">${icon('users')} ${t('newGroupChat')}</button></div>
      <input id="conv-search" class="conv-search" type="search" placeholder="${t('searchConversations')}" autocomplete="off" aria-label="${t('searchConversations')}" />
      ${onlineUsers.length ? `<div class="active-rail" aria-label="${t('activeNow')}">${onlineUsers.map((u) => `<button class="active-person" data-act="message-user" data-id="${escapeHtml(u.id)}" title="${escapeHtml(u.name)}">${avatarHtml(u, 44)}<span class="active-dot"></span><span class="active-name">${escapeHtml(u.name.split(' ')[0])}</span></button>`).join('')}</div>` : ''}
      <div class="row gap-sm conv-filters">
        <button class="btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-ghost'}" data-act="conv-filter" data-filter="all">${t('allChats')}</button>
        <button class="btn btn-sm ${filter === 'unread' ? 'btn-primary' : 'btn-ghost'}" data-act="conv-filter" data-filter="unread">${t('unreadChats')}</button>
        <button class="btn btn-sm ${filter === 'archived' ? 'btn-primary' : 'btn-ghost'}" data-act="conv-filter" data-filter="archived">${icon('archive')} ${t('archivedChats')}${archivedCount ? ` (${archivedCount})` : ''}</button>
        <button class="btn btn-sm ${filter === 'requests' ? 'btn-primary' : 'btn-ghost'}" data-act="conv-filter" data-filter="requests">${icon('inbox')} ${t('messageRequests')}${requestsCount ? ` (${requestsCount})` : ''}</button>
      </div>
      ${listedConvs.map((x) => `<div class="conv-item-wrap">
        <button class="conv-item ${active?.conv.id === x.conv.id ? 'active' : ''}" data-act="open-conv" data-id="${escapeHtml(x.conv.id)}" data-search="${escapeHtml(x.searchText)}">
        ${avatarHtml(x.avatarUser, 44)}<span class="grow left conv-item-text"><b class="conv-title">${x.pinned ? icon('pin', 'ic-sm') + ' ' : ''}${x.isGroup ? icon('users', 'ic-sm') + ' ' : ''}${escapeHtml(x.title)}${x.isGroup ? '' : verifiedBadgeHtml(x.other)}</b> <span class="conv-preview muted small">${x.muted ? icon('bell-off', 'ic-sm') + ' ' : ''}${escapeHtml(x.preview)}</span></span>
        ${x.mentionUnread ? `<span class="mention-badge" title="${t('mentionedYou')}">@</span>` : ''}${x.unread && !x.muted ? `<span class="unread-badge">${x.unread}</span>` : ''}${x.unread && x.muted ? `<span class="unread-badge muted-badge">${x.unread}</span>` : ''}
        </button>
        <button class="icon-btn conv-menu-btn" data-act="conv-menu" data-id="${escapeHtml(x.conv.id)}" title="${t('conversationOptions')}" aria-label="${t('conversationOptions')}">${icon('more-horizontal')}</button>
        <div class="menu conv-menu ${uiState.convMenuFor === x.conv.id ? '' : 'hidden'}" id="conv-menu-${escapeHtml(x.conv.id)}">
          <button data-act="conv-pin" data-id="${escapeHtml(x.conv.id)}">${x.pinned ? `${icon('pin')} ${t('unpinChat')}` : `${icon('pin')} ${t('pinChat')}`}</button>
          <button data-act="conv-archive" data-id="${escapeHtml(x.conv.id)}">${x.archived ? `${icon('archive-restore')} ${t('unarchiveChat')}` : `${icon('archive')} ${t('archiveChat')}`}</button>
          ${x.muted ? `<button data-act="conv-mute" data-id="${escapeHtml(x.conv.id)}" data-ms="">${icon('bell')} ${t('unmuteChat')}</button>` : `<button data-act="conv-mute" data-id="${escapeHtml(x.conv.id)}" data-ms="3600000">${icon('bell-off')} ${t('muteFor1Hour')}</button><button data-act="conv-mute" data-id="${escapeHtml(x.conv.id)}" data-ms="86400000">${icon('bell-off')} ${t('muteFor24Hours')}</button><button data-act="conv-mute" data-id="${escapeHtml(x.conv.id)}" data-ms="inf">${icon('bell-off')} ${t('muteForever')}</button>`}
        </div>
      </div>`).join('') || `<p class="muted small">${filter === 'archived' ? t('noArchivedChats') : filter === 'requests' ? t('noRequests') : t('noMessages')}</p>
      <div class="stack"><h4>Start a chat</h4>${d.users.filter((u) => u.id !== meUser.id).slice(0, 6).map((u) => `<button class="conv-item" data-act="message-user" data-id="${escapeHtml(u.id)}">${avatarHtml(u, 36)}<span>${escapeHtml(u.name)}${verifiedBadgeHtml(u)}</span></button>`).join('')}</div>`}
    </div>
    <div class="conv-thread">
      ${active ? `
      ${(() => { const theme = chatTheme(active.conv.theme); const pinned = pinnedMessages(active.msgs); const latestPinned = pinned[0]; return `
      <header class="thread-head"><a class="thread-back" href="#/messages" aria-label="Back to conversations">${icon('arrow-left')}</a>${avatarHtml(active.avatarUser, 40)}<div><b>${active.isGroup ? icon('users', 'ic-sm') + ' ' : ''}${escapeHtml(active.title)}${active.isGroup ? '' : verifiedBadgeHtml(active.other)}</b><br/><span class="muted small">${active.isGroup ? `${active.conv.participants.length} ${t('members')}` : `${active.other?.online ? t('online') : t('offline')}`}</span></div>
      <span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-act="conv-info" title="${t('conversationDetails')}" aria-label="${t('conversationDetails')}">${icon('info')}</button>${active.isGroup ? '' : `<button class="btn btn-ghost btn-sm" data-act="report-user" data-id="${active.other?.id}" title="${t('report')}" aria-label="${t('report')}">${icon('flag')}</button>`}</header>
      ${latestPinned ? `<button type="button" class="pinned-bar" data-act="jump-message" data-id="${escapeHtml(latestPinned.id)}"><span class="pinned-bar-label">${icon('pin')} ${t('pinnedMessage')}</span><span class="pinned-bar-text">${escapeHtml(messageSnippet(latestPinned, 90))}</span></button>` : ''}
      <div id="conv-info" class="conv-info${uiState.convInfoFor === active.conv.id ? '' : ' hidden'}">
        <div class="conv-info-section"><h4>${icon('palette')} ${t('chatTheme')}</h4>
          <div class="theme-swatches">${CHAT_THEMES.map((th) => `<button type="button" class="theme-swatch ${theme.id === th.id ? 'active' : ''}" data-act="set-theme" data-conv="${escapeHtml(active.conv.id)}" data-theme="${escapeHtml(th.id)}" title="${t(`theme_${escapeHtml(th.id)}`)}" aria-label="${t(`theme_${escapeHtml(th.id)}`)}" style="${th.gradient ? `background:${th.gradient};` : ''}">${th.id === 'default' ? '∅' : ''}</button>`).join('')}</div>
          <p class="muted small">${t(`theme_${escapeHtml(theme.id)}`)}</p>
        </div>
        <div class="conv-info-section"><h4>${icon('pin')} ${t('pinnedMessages')}</h4>
          ${pinned.length ? pinned.map((m) => `<button type="button" class="pinned-item" data-act="jump-message" data-id="${escapeHtml(m.id)}"><b>${escapeHtml((byId[m.senderId]?.name || '').split(' ')[0])}</b><span class="grow">${escapeHtml(messageSnippet(m, 80))}</span><span class="muted small">${timeAgo(m.createdAt)}</span></button>`).join('') : `<p class="muted small">${t('noPinnedMessages')}</p>`}
        </div>
        <div class="conv-info-section"><h4>${icon('smile')} ${t('chatEmoji')}</h4>
          <div class="emoji-swatches">${['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉', '😍', '👏', '💯', '🌙'].map((e) => `<button type="button" class="emoji-swatch ${(active.conv.emoji || '👍') === e ? 'active' : ''}" data-act="set-conv-emoji" data-conv="${escapeHtml(active.conv.id)}" data-emoji="${e}" aria-label="${t('chatEmoji')} ${e}">${e}</button>`).join('')}</div>
          <p class="muted small">${t('chatEmojiHint')}</p>
        </div>
        <div class="conv-info-section"><h4>${icon('eye-off')} ${t('vanishMode')}</h4>
          <div class="row gap-sm"><span class="grow small">${active.conv.vanish ? t('vanishOnText') : t('vanishOffText')}</span><button class="btn btn-ghost btn-sm" data-act="vanish-toggle" data-conv="${escapeHtml(active.conv.id)}">${active.conv.vanish ? t('turnOff') : t('turnOn')}</button></div>
          <p class="muted small">${t('vanishHint')}</p>
        </div>
        <div class="conv-info-section"><h4>${icon('tag')} ${t('nicknames')}</h4>
          ${active.conv.participants.map((id) => `<div class="row gap-sm"><span class="grow row gap-sm">${avatarHtml(byId[id], 28)}<span>${escapeHtml(nicknameFor(active.conv, id, byId[id]?.name || ''))}${active.conv.nicknames?.[id] ? ` <span class="muted small">(${escapeHtml(byId[id]?.name || '')})</span>` : ''}</span></span><button class="btn btn-ghost btn-sm" data-act="set-nickname" data-conv="${escapeHtml(active.conv.id)}" data-id="${id}">${t('setNickname')}</button></div>`).join('')}
          <p class="muted small">${t('nicknameHint')}</p>
        </div>
        <div class="conv-info-section"><h4>${icon('search')} ${t('searchInConversation')}</h4>
          <input id="conv-msg-search" class="conv-search" type="search" placeholder="${t('searchInConversation')}" autocomplete="off" data-conv="${escapeHtml(active.conv.id)}" aria-label="${t('searchInConversation')}" />
          <div id="conv-search-results"></div>
        </div>
        ${(() => { const media = active.msgs.filter((m) => m.image && !m.unsent); return media.length ? `<div class="conv-info-section"><h4>${icon('image')} ${t('sharedMedia')}</h4><div class="media-grid">${media.slice(-9).reverse().map((m) => `<button type="button" class="media-thumb" data-act="jump-message" data-id="${escapeHtml(m.id)}"><img src="${escapeHtml(safeMediaUrl(cldImg(m.image, 480)))}" alt="${t('sharedMedia')}" loading="lazy" decoding="async" /></button>`).join('')}</div></div>` : ''; })()}
        ${active.isGroup ? (() => { const conv = active.conv; const canManage = conv.createdBy === meUser.id || isAdminRole(meUser); const addable = [...friendIdsOfData(d, meUser.id)].map((id) => byId[id]).filter((u) => u && !conv.participants.includes(u.id)); return `<div class="conv-info-section"><h4>${icon('users')} ${t('members')}</h4>
          <form id="group-rename-form" data-conv="${escapeHtml(conv.id)}" class="row gap-sm pf-form">
            <input name="title" class="grow" value="${escapeHtml(conv.title || '')}" maxlength="60" aria-label="${t('groupName')}" />
            <button class="btn btn-ghost btn-sm" type="submit">${t('renameGroup')}</button>
          </form>
          <div class="stack gap-sm"><b class="small">${icon('link')} ${t('inviteLink')}</b>
          ${conv.joinCode ? `<div class="row gap-sm"><input class="grow" readonly value="${escapeHtml(inviteLinkFor(conv.joinCode))}" aria-label="${t('inviteLink')}" /><button class="btn btn-ghost btn-sm" data-act="copy-invite" data-link="${escapeHtml(inviteLinkFor(conv.joinCode))}">${t('copyLink')}</button></div>` : (conv.createdBy === meUser.id ? `<button class="btn btn-ghost btn-sm" data-act="create-invite" data-conv="${escapeHtml(conv.id)}">${t('createInviteLink')}</button>` : '')}
          <span class="muted small">${t('inviteHint')}</span></div>
          ${conv.participants.map((id) => `<div class="row gap-sm"><span class="grow row gap-sm">${avatarHtml(byId[id], 28)}<span>${escapeHtml(byId[id]?.name || '')}${verifiedBadgeHtml(byId[id])}</span>${conv.createdBy === id ? `<span class="badge badge-ok">${t('groupCreator')}</span>` : ''}</span>${id !== meUser.id && canManage ? `<button class="btn btn-ghost btn-sm" data-act="group-remove-member" data-conv="${escapeHtml(conv.id)}" data-id="${id}">${t('removeMember')}</button>` : ''}</div>`).join('')}
          ${addable.length ? `<details><summary>${t('addMembers')}</summary><form id="group-add-form" data-conv="${escapeHtml(conv.id)}" class="stack group-pick-list">${addable.map((u) => `<label class="row gap-sm"><input type="checkbox" name="member" value="${escapeHtml(u.id)}" /> ${avatarHtml(u, 26)}<span>${escapeHtml(u.name)}</span></label>`).join('')}<div class="row gap end"><button class="btn btn-primary btn-sm" type="submit">${t('addMembers')}</button></div></form></details>` : ''}
          <button class="btn btn-danger btn-sm" data-act="group-leave" data-conv="${escapeHtml(conv.id)}">${icon('log-out')} ${t('leaveGroup')}</button>
        </div>`; })() : ''}
      </div>
      <div class="thread-body" id="thread-body" style="${theme.tint ? `background:${theme.tint};` : ''}${theme.bubble ? `--bubble-mine:${theme.bubble};` : ''}">
        ${active.msgs.map((m) => messageHtml(m, meUser, byId, active.isGroup, active.conv)).join('') || '<p class="muted center">No messages yet. Say hello 👋</p>'}
      </div>
      ${sharedMsgPickersHtml()}
      ${sharedMsgMenuHtml()}
      <div class="typing-row" id="typing-row">${typingIndicatorHtml(active.conv, meUser, byId)}</div>
      ${active.request ? `<div class="request-banner">${icon('inbox')} <span class="grow"><b>${escapeHtml(active.other?.name || '')}</b> ${t('requestHint')}</span><button class="btn btn-primary btn-sm" data-act="accept-msg-request" data-id="${escapeHtml(active.conv.id)}">${t('acceptRequest')}</button></div>` : ''}
      ${active.conv.vanish ? `<div class="vanish-banner">${icon('eye-off')} ${t('vanishBanner')}</div>` : ''}
      <div class="composer-wrap">
        <div id="mention-menu" class="mention-menu hidden"></div>
        <div id="reply-preview" class="message-preview reply-preview hidden"></div>
        <div id="message-preview" class="message-preview hidden"></div>`; })()}
        <div id="composer-tray" class="composer-tray hidden">
          <button type="button" class="btn btn-ghost" data-act="sticker-toggle" title="${t('stickers')}" aria-label="${t('stickers')}">${icon('sticker')}</button>
          <label class="btn btn-ghost msg-attach" for="msg-file-input" title="${t('attachFile')}" aria-label="${t('attachFile')}">${icon('paperclip')}</label>
          <button type="button" class="btn btn-ghost" data-act="send-location" title="${t('shareLocation')}" aria-label="${t('shareLocation')}">${icon('map-pin')}</button>
          <button type="button" class="btn btn-ghost" data-act="poll-open" data-conv="${escapeHtml(active.conv.id)}" title="${t('createPoll')}" aria-label="${t('createPoll')}">${icon('bar-chart')}</button>
          <label class="btn btn-ghost msg-attach" for="msg-image-input" title="${t('photo')}" aria-label="${t('photo')}">${icon('image')}</label>
        </div>
        <form id="message-form" data-conv="${escapeHtml(active.conv.id)}" class="message-form">
          <input type="file" id="msg-image-input" name="image" accept="image/*" hidden />
          <input type="file" id="msg-file-input" name="file" hidden />
          <button type="button" class="btn btn-ghost btn-sm" data-act="composer-more" title="${t('moreOptions')}" aria-label="${t('moreOptions')}">${icon('plus')}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="emoji-toggle" title="Emoji" aria-label="Emoji">${icon('smile')}</button>
          <input name="text" placeholder="Type a message…" autocomplete="off" maxlength="2000" />
          <button type="button" class="btn btn-ghost btn-sm" id="voice-btn" data-act="voice-toggle" title="${t('voiceMessage')}" aria-label="${t('voiceMessage')}">${icon('mic')}</button>
          <button type="button" class="btn btn-ghost thread-emoji-btn" data-act="send-thread-emoji" data-conv="${escapeHtml(active.conv.id)}" title="${t('chatEmoji')}" aria-label="${t('chatEmoji')}">${escapeHtml(active.conv.emoji || '👍')}</button>
          <button class="btn btn-primary msg-send-btn" type="submit" title="${t('send')}" aria-label="${t('send')}">${icon('send')}</button>
        </form>
        <div id="emoji-panel" class="emoji-panel hidden">
          ${CHAT_EMOJIS.map((e) => `<button type="button" class="emoji-btn" data-emoji-insert="${e}" aria-label="Insert ${e}">${e}</button>`).join('')}
        </div>
        <div id="sticker-panel" class="sticker-panel hidden">
          ${STICKER_PACKS.map((p) => `<div class="sticker-pack"><h5>${escapeHtml(p.label)}</h5><div class="sticker-grid">${p.stickers.map((e) => `<button type="button" class="sticker-btn" data-act="send-sticker" data-emoji="${e}" aria-label="${t('stickers')} ${e}">${e}</button>`).join('')}</div></div>`).join('')}
        </div>
        <div id="voice-ui" class="voice-ui hidden">
          <span class="voice-dot"></span><span id="voice-time" class="mono">0:00</span><span class="grow small">${t('recording')}…</span>
          <button class="btn btn-ghost btn-sm" data-act="voice-cancel">${icon('x')} ${t('cancel')}</button>
          <button class="btn btn-primary btn-sm" data-act="voice-send">${t('send')}</button>
        </div>
      </div>` : `<div class="empty-state"><div class="empty-icon">${icon('message-circle', 'ic-xl')}</div><p class="muted">${t('selectConversation')}</p></div>`}
    </div>
  </div>`;
}

// Emoji set for the Messenger picker (~24 common ones).
const CHAT_EMOJIS = ['😀', '😂', '🤣', '😍', '🥰', '😊', '😎', '🤔', '😴', '😢', '😮', '😅', '😭', '👍', '👏', '🙏', '❤️', '🔥', '🎉', '✨', '🌙', '☕', '🍰', '📷'];

// safeMediaUrl / safeCssImageUrl live in utils.js (shared with
// components.js and main.js): scheme allowlist for every media URL
// rendered into a src/href/CSS url() — escapeHtml alone does not
// stop a crafted javascript: URL in a synced doc.

// Message body text: escaped first, then the @handles of the users
// recorded in m.mentions are wrapped in a highlight span.
function messageTextHtml(m, byId) {
  let html = escapeHtml(m.text || '');
  for (const uid of m.mentions || []) {
    const u = byId[uid];
    if (!u) continue;
    if (u.username) html = html.split(`@${escapeHtml(u.username)}`).join(`<span class="msg-mention">@${escapeHtml(u.username)}</span>`);
    if (u.name) html = html.split(`@${escapeHtml(u.name)}`).join(`<span class="msg-mention">@${escapeHtml(u.name)}</span>`);
  }
  return html;
}

function messageHtml(m, meUser, byId, isGroup = false, conv = null) {
  const mine = m.senderId === meUser.id;
  // Unsent messages render as a tombstone for everyone (Messenger
  // Complete Pack): the content is gone, the thread keeps its shape.
  if (m.unsent) {
    return `<div class="msg-row ${mine ? 'mine' : ''}" id="msg-${escapeHtml(m.id)}">
    ${mine ? '' : avatarHtml(byId[m.senderId], 28)}
    <div class="msg-bubble msg-unsent"><i>${icon('ban', 'ic-sm')} ${mine ? t('youUnsentMessage') : t('messageUnsent')}</i></div>
  </div>`;
  }
  // Own-message status as words (Facebook-style): "Seen" once any other
  // participant has it in readBy / the status flipped to read, else "Sent".
  const seen = m.status === 'read' || (m.readBy || []).length > 1;
  const status = mine ? (seen ? `${icon('check-check', 'ic-sm')} ${t('seen')}` : `${icon('check', 'ic-sm')} ${t('sent')}`) : '';
  const chips = reactionChips(m.reactions);
  const bigEmoji = Boolean(m.text) && !m.image && !m.audio && isEmojiOnlyText(m.text);
  const editable = canEditMessage(m, meUser.id);
  return `<div class="msg-row ${mine ? 'mine' : ''}" id="msg-${escapeHtml(m.id)}">
    ${mine ? '' : avatarHtml(byId[m.senderId], 28)}
    <div class="msg-col">
    <div class="msg-bubble ${mine ? 'mine' : ''}${bigEmoji || m.sticker ? ' msg-bubble-bare' : ''}${m.vanish ? ' msg-vanish' : ''}">
      ${isGroup && !mine ? `<span class="msg-sender">${escapeHtml(nicknameFor(conv, m.senderId, byId[m.senderId]?.name || ''))}${verifiedBadgeHtml(byId[m.senderId])}</span>` : ''}
      ${m.forwarded ? `<span class="msg-forwarded">${icon('forward', 'ic-sm')} ${t('forwarded')}</span>` : ''}
      ${m.replyToId ? `<button type="button" class="msg-quote" data-act="jump-message" data-id="${escapeHtml(m.replyToId)}"><b>${escapeHtml(m.replyToName || '')}</b><span>${escapeHtml(m.replyToText || '')}</span></button>` : ''}
      ${m.image ? `<img class="msg-image" src="${escapeHtml(safeMediaUrl(cldImg(m.image, 800)))}" alt="Shared photo" loading="lazy" decoding="async" />` : ''}
      ${m.audio ? `<audio class="msg-audio" controls preload="metadata" src="${escapeHtml(safeMediaUrl(m.audio))}"></audio>` : ''}
      ${m.file ? `<a class="msg-file" href="${escapeHtml(safeMediaUrl(m.file.url))}" target="_blank" rel="noopener noreferrer" download="${escapeHtml(m.file.name || 'file')}"><span class="msg-file-icon">${icon('file-text')}</span><span class="grow"><b>${escapeHtml(m.file.name || t('file'))}</b><small>${formatBytes(m.file.size)} · ${t('download')}</small></span></a>` : ''}
      ${m.sticker ? `<p class="msg-sticker">${escapeHtml(m.sticker)}</p>` : ''}
      ${m.location ? `<a class="msg-location" href="${escapeHtml(mapsUrl(m.location))}" target="_blank" rel="noopener noreferrer"><span class="msg-location-pin">${icon('map-pin')}</span><span class="grow"><b>${t('sharedLocation')}</b><small>${Number(m.location.lat).toFixed(5)}, ${Number(m.location.lng).toFixed(5)} · ${t('openInMaps')}</small></span></a>` : ''}
      ${m.poll ? (() => { const total = chatPollTotal(m.poll); return `<div class="chat-poll"><b>${icon('bar-chart')} ${escapeHtml(m.poll.question || '')}</b>${(m.poll.options || []).map((o) => { const pct = total ? Math.round((o.votes || []).length / total * 100) : 0; const voted = (o.votes || []).includes(meUser.id); return `<button type="button" class="chat-poll-option ${voted ? 'voted' : ''}" data-act="vote-poll" data-id="${escapeHtml(m.id)}" data-option="${escapeHtml(o.id)}"><span class="chat-poll-fill" style="width:${pct}%"></span><span class="chat-poll-text">${voted ? icon('check', 'ic-sm') + ' ' : ''}${escapeHtml(o.text)}</span><span class="chat-poll-count">${(o.votes || []).length} · ${pct}%</span></button>`; }).join('')}<span class="muted small">${total} ${t('votes')}</span></div>`; })() : ''}
      ${m.text ? `<p${bigEmoji ? ' class="msg-big-emoji"' : ''}>${messageTextHtml(m, byId)}</p>` : ''}
      <span class="msg-foot"><span class="msg-meta">${m.pinned ? icon('pin', 'ic-sm') + ' ' : ''}${timeAgo(m.createdAt)}${m.editedAt ? ` · ${t('edited')}` : ''}${m.vanish ? ` · ${icon('eye-off', 'ic-sm')}` : ''} ${status}</span><span class="msg-actions"><button type="button" class="link-btn msg-act-btn" data-act="reply-message" data-id="${escapeHtml(m.id)}" title="${t('replyToMessage')}" aria-label="${t('replyToMessage')}">${icon('reply')}</button><button type="button" class="link-btn msg-act-btn" data-act="msg-react-toggle" data-id="${escapeHtml(m.id)}" title="${t('reactToMessage')}" aria-label="${t('reactToMessage')}">${icon('smile')}</button><button type="button" class="link-btn msg-act-btn ${m.pinned ? 'active' : ''}" data-act="pin-message" data-id="${escapeHtml(m.id)}" title="${t(m.pinned ? 'unpinMessage' : 'pinMessage')}" aria-label="${t(m.pinned ? 'unpinMessage' : 'pinMessage')}">${m.pinned ? iconFill('pin') : icon('pin')}</button>${editable ? `<button type="button" class="link-btn msg-act-btn" data-act="edit-message" data-id="${escapeHtml(m.id)}" title="${t('editMessage')}" aria-label="${t('editMessage')}">${icon('pencil')}</button>` : ''}<button type="button" class="link-btn msg-act-btn" data-act="msg-menu" data-id="${escapeHtml(m.id)}" title="${t('messageOptions')}" aria-label="${t('messageOptions')}">${icon('more-horizontal')}</button>${mine ? '' : `<button class="link-btn msg-report-btn" data-act="report-message" data-id="${escapeHtml(m.id)}" title="${t('report')}" aria-label="${t('report')}">${icon('flag')}</button>`}</span></span>
    </div>
    ${chips.length ? `<div class="msg-chips">${chips.map((c) => `<button type="button" class="msg-chip ${c.uids.includes(meUser.id) ? 'mine' : ''}" data-act="msg-react" data-id="${escapeHtml(m.id)}" data-emoji="${c.emoji}" title="${t('reactToMessage')}">${c.emoji} ${c.count}</button>`).join('')}</div>` : ''}
    </div>
  </div>`;
}

// ONE shared reaction-picker pair + per-message menu for the whole
// thread, rendered once by messagesView (thread-lightening: rows used
// to each carry hidden copies — ~42 DOM nodes per message). main.js
// moves these single elements into the active message's bubble /
// column on demand and stamps the target message id onto their
// buttons, so the delegated data-act handlers work unchanged; closed,
// they sit hidden here, and a re-render recreates them hidden — the
// same reset the per-row copies had. The menu's Unsend button is
// always present in the shared copy; main.js hides it for other
// people's messages when it mounts the menu.
export function sharedMsgPickersHtml() {
  return `<div class="msg-picker hidden" id="msg-picker">${MESSAGE_REACTIONS.map((e) => `<button type="button" class="emoji-btn" data-act="msg-react" data-emoji="${e}" aria-label="${t('reactToMessage')} ${e}">${e}</button>`).join('')}<button type="button" class="emoji-btn" data-act="react-more" title="${t('moreReactions')}" aria-label="${t('moreReactions')}">${icon('plus')}</button></div>
  <div class="msg-picker msg-picker-more hidden" id="msg-picker-more">${REACTION_EMOJI_SET.map((e) => `<button type="button" class="emoji-btn" data-act="msg-react" data-emoji="${e}" aria-label="${t('reactToMessage')} ${e}">${e}</button>`).join('')}</div>`;
}

export function sharedMsgMenuHtml() {
  return `<div class="menu msg-menu hidden" id="msg-menu">
      <button data-act="forward-message">${icon('forward')} ${t('forwardMessage')}</button>
      <button data-act="unsend-message">${icon('ban')} ${t('unsendMessage')}</button>
      <button data-act="hide-message">${icon('trash')} ${t('removeForMe')}</button>
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
  return `<h3>${icon('users')} ${t('newGroupChat')}</h3>
  <form id="group-chat-form" class="stack pf-form">
    <label>${t('groupChat')}<input name="title" maxlength="60" placeholder="e.g. Weekend Plans" /></label>
    <div class="stack group-pick-list">
      ${friends.length ? friends.map((u) => `<label class="row gap-sm"><input type="checkbox" name="member" value="${escapeHtml(u.id)}" /> ${avatarHtml(u, 30)}<span>${escapeHtml(u.name)}</span></label>`).join('') : `<p class="muted small">${t('noFriendsForGroupChat')}</p><div><a class="btn btn-primary btn-sm" href="#/friends" data-close>🔍 ${t('findFriends')}</a></div>`}
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
  const icons = { friend_request: 'users', friend_accept: 'check-circle', like: 'heart', comment: 'message-circle', reply: 'reply', message: 'mail', mention: 'at-sign', share: 'repeat', follow: 'user-plus', group_join: 'users-round', page_follow: 'flag', group_request: 'inbox', group_request_result: 'users-round', event_rsvp: 'calendar', report_decision: 'flag', moderation_notice: 'scale', appeal_decision: 'mail', warning: 'alert-triangle' };
  // Notification text is a sentence with the actor's name inside it:
  // for a verified actor, splice the seal in right after their name.
  // Both sides are escaped before the splice; the badge is static
  // markup, so nothing unescaped ever reaches the HTML.
  const notifTextHtml = (n) => {
    const actor = byId[n.actorId];
    const esc = escapeHtml(notificationText(n, byId));
    if (!isVerifiedUser(actor) || !actor.name) return esc;
    const escName = escapeHtml(actor.name);
    return esc.includes(escName) ? esc.replace(escName, escName + verifiedBadgeHtml(actor)) : esc;
  };
  return `<div class="page narrow">
    <div class="row"><h2 class="grow">${icon('bell')} ${t('notifications')}</h2><button class="btn btn-ghost btn-sm" data-act="notif-read-all">${t('markAllRead')}</button></div>
    ${mine.map((n) => `<button class="card notif ${n.read ? '' : 'unread'}" data-act="notif-open" data-id="${escapeHtml(n.id)}" data-post="${n.postId || ''}" data-conv="${n.conversationId || ''}" data-actor="${n.actorId || ''}" data-group="${n.groupId || ''}" data-page="${n.pageId || ''}" data-event="${n.eventId || ''}">
      ${avatarHtml(byId[n.actorId], 40)}<span class="grow left">${icon(icons[n.type] || 'bell')} ${notifTextHtml(n)}<br/><span class="muted small">${timeAgo(n.createdAt)}</span></span>
    </button>`).join('') || emptyState('bell', t('noNotifications'))}
  </div>`;
}

// ------------------------------------------------------------------ SEARCH
export function searchView(d, meUser, queryText) {
  const q = String(queryText || '').trim().toLowerCase();
  const byId = usersById(d);
  const blocked = blockedIdsOfData(d, meUser.id);
  const users = q ? d.users.filter((u) => !blocked.has(u.id) && (u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))) : [];
  // Groups: every group in the mirror is discoverable — private
  // groups arrive as metadata-only rows and are labelled as such;
  // their posts and member list stay behind the group page's
  // member gate, exactly as on the Groups page.
  const groups = q ? (d.groups || []).filter((g) => (g.name || '').toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q)) : [];
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
    <h2>${icon('search')} Search ${q ? `for “${escapeHtml(queryText)}”` : ''}</h2>
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
      else if (rel?.status === 'accepted') action = `<span class="badge badge-ok">${icon('check', 'ic-sm')} ${t('friendsLabel')}</span>`;
      else if (rel?.status === 'pending' && rel.from === meUser.id) action = `<button class="btn btn-ghost btn-sm" data-act="cancel-request" data-id="${escapeHtml(rel.id)}" title="${t('tapToCancel')}">${icon('check')} ${t('requestSent')}</button>`;
      else if (rel?.status === 'pending') action = `<button class="btn btn-primary btn-sm" data-act="accept-request" data-id="${escapeHtml(rel.id)}">Accept request</button>`;
      else action = `<button class="btn btn-primary btn-sm" data-act="send-request" data-id="${escapeHtml(u.id)}">${t('addFriend')}</button>`;
      return `<div class="card person-card">${avatarHtml(u, 56)}<a href="#/profile/${escapeHtml(u.id)}"><b>${escapeHtml(u.name)}</b></a>${verifiedBadgeHtml(u)}<span class="muted small">@${escapeHtml(u.username)}</span>${mutual > 0 ? `<span class="muted small">${mutual} ${mutual === 1 ? t('mutualFriend') : t('mutualFriends')}</span>` : ''}${action ? `<div class="row gap wrap center">${action}</div>` : ''}</div>`;
    }).join('') || '<p class="muted">No people matched.</p>'}</div>
    <h3>${t('groups')}</h3>
    <div class="grid-people">${groups.map((g) => `<div class="card person-card">${avatarHtml({ name: g.name, username: g.name, avatar: g.cover }, 56)}<a href="#/group/${escapeHtml(g.id)}"><b>${escapeHtml(g.name)}</b></a><span class="muted small">${g.privacy === 'private' ? icon('lock', 'ic-sm') + ' ' + t('privateLabel') : icon('globe', 'ic-sm') + ' ' + t('publicLabel')} · ${plural(groupMemberCount(g), t('member'), t('members'))}</span><div class="row gap wrap center"><a class="btn btn-ghost btn-sm" href="#/group/${escapeHtml(g.id)}">View</a></div></div>`).join('') || '<p class="muted">No groups matched.</p>'}</div>
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
  return `<div class="page narrow"><h2>${icon('bookmark')} ${t('saved')} posts</h2>${posts.map((p) => postCardHtml(p, ctx)).join('') || emptyState('bookmark', 'Posts you save will appear here.')}</div>`;
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
    <h2>${icon('settings')} ${t('settings')}</h2>
    <div class="card stack">
      <h3>${t('settingsAccount')}</h3>
      <p><b>${escapeHtml(meUser.name)}</b> · @${escapeHtml(meUser.username)}<br/><span class="muted">${escapeHtml(meUser.email || '')}</span></p>
      <div class="row gap wrap">
        <button class="btn btn-ghost" data-act="edit-profile">${icon('pencil')} ${t('editProfile')}</button>
        <button class="btn btn-ghost" data-act="change-password">${icon('mail')} ${t('sendResetEmail')}</button>
        <button class="btn btn-ghost settings-logout" data-act="logout">${icon('log-out')} ${t('logout')}</button>
      </div>
    </div>
    <div class="card stack">
      <h3>${icon('inbox')} ${t('supportInbox')}</h3>
      <p class="muted">${t('supportInboxHelp')}</p>
      <div><a class="btn btn-ghost btn-sm" href="#/support">${t('supportOpenInbox')}</a></div>
    </div>
    <div class="card stack">
      <h3>${t('settingsAppearance')}</h3>
      <div class="row gap wrap">
        <button class="btn btn-ghost" data-act="toggle-theme">${prefs.theme === 'dark' ? icon('sun') + ' ' + t('lightMode') : icon('moon') + ' ' + t('darkMode')}</button>
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
      <form id="notif-prefs-form" class="stack pf-form">
        ${types.map((type) => `<label class="notif-pref-row"><span class="grow">${prefLabels[type]}</span><input type="checkbox" name="${type}" ${np[type] === false ? '' : 'checked'} /></label>`).join('')}
        <label class="notif-pref-row"><span class="grow">${icon('bell')} ${t('browserNotifications')}</span><input type="checkbox" name="browserNotifications" ${meUser.settings?.browserNotifications ? 'checked' : ''} /></label>
        <p class="muted small">${t('browserNotificationsHelp')}</p>
        <div><button class="btn btn-primary btn-sm" type="submit">${t('savePreferences')}</button></div>
      </form>
    </div>
    <div class="card stack">
      <h3>${t('settingsPrivacy')}</h3>
      <form id="privacy-prefs-form" class="stack pf-form">
        <label>${t('defaultPostPrivacy')}
          <select name="defaultPostPrivacy">
            <option value="public" ${defaultPrivacy === 'public' ? 'selected' : ''}>${t('publicLabel')}</option>
            <option value="friends" ${defaultPrivacy === 'friends' ? 'selected' : ''}>${t('friends')}</option>
            <option value="close" ${defaultPrivacy === 'close' ? 'selected' : ''}>${t('closeFriends')}</option>
            <option value="only-me" ${defaultPrivacy === 'only-me' ? 'selected' : ''}>${t('onlyMe')}</option>
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
      <h3>${icon('alert-triangle')} ${t('dangerZone')}</h3>
      <p class="muted small">${t('dangerZoneHelp')}</p>
      <div><button class="btn btn-danger" data-act="delete-account">${t('deleteAccount')}</button></div>
    </div>
  </div>`;
}


// #/admin — overview dashboard (Pack B). Every number comes from
// utils.platformStats over the dataset the admin client actually
// holds, upgraded per-metric by api.loadAdminStats server aggregates
// in live mode; a metric served from the loaded subset is labelled
// "from loaded data" rather than presented as a platform total.

// ----------------------------------------------------- analytics (B)
// Dependency-free inline SVG charts over utils.analyticsSeries. Bars
// carry <title> tooltips (day + value); the full series is also in the
// data table under the charts, and the CSV export (main.js) downloads
// exactly the series on screen.

// #/admin/analytics — platform analytics (analyst+). Aggregates only.

// ------------------------------------------------------- content (B)
// #/admin/content — moderation over the posts the admin client has
// loaded: Posts (search/filter/paginate/delete), Comments (flattened,
// delete), Possible spam (labelled heuristics, same delete actions).

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
  return `<h3>${icon('flag')} ${t('reportDialogTitle')}</h3>
  <form id="report-form" data-type="${escapeHtml(targetType)}" data-id="${escapeHtml(targetId)}" class="stack pf-form">
    <label>${t('categoryLabel')}<select name="category">${REPORT_CATEGORIES.map((c) => `<option value="${c}">${escapeHtml(reportCategoryLabel(c))}</option>`).join('')}</select></label>
    <label>${t('reportReasonLabel')}<textarea name="reason" rows="3" maxlength="500" required placeholder="${t('reportReasonLabel')}"></textarea></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>${t('cancel')}</button><button class="btn btn-primary" type="submit">${t('reportSubmit')}</button></div>
  </form>`;
}

// Resolve dialog: the moderator picks the outcome; side effects
// (delete content / warn / suspend) run inside api.adminDecideReport.

// #/admin/reports — the Report Management Center. Status filter tabs
// with counts; each card shows the category, target, reporter, the
// user-submitted evidence for message reports (never a conversation),
// the moderation history (decision record) and appeal controls.

// ------------------------------------------------------- SUPPORT INBOX
// #/support — the user-side mirror of the Reports Center (modelled on
// Facebook's Support Inbox). Two sections over the same report docs:
// "My reports" (filed by me, with the moderator's decision) and "My
// notices" (decisions that took action on MY content, each with a
// one-shot appeal). Live mode feeds it from remote.supportReports
// (two provable per-user listeners); demo mode reads the full store —
// either way the view unions both lists and filters by identity.
export function supportTargetAuthorId(d, r) {
  if (!r) return '';
  if (r.targetAuthorId) return r.targetAuthorId;
  if (r.targetType === 'user') return r.targetId || '';
  if (r.targetType === 'message') return r.evidence?.senderId || '';
  if (r.targetType === 'post') return (d.posts || []).find((p) => p.id === r.targetId)?.authorId || '';
  return '';
}

// What a report was about, as a short human-readable snippet: the
// snapshot stamped at creation (report.targetLabel) wins — the
// decision may have hard-deleted the target doc — otherwise derive
// from the still-live target; '' when nothing identifiable remains.
// Shared by the Reports Center card and the Support Inbox so both
// degrade identically (author name / "Photo post", never a doc id).
export function reportTargetSnapshot(d, r, byId = usersById(d)) {
  if (r.targetLabel) return String(r.targetLabel);
  if (r.targetType === 'post') {
    const p = (d.posts || []).find((x) => x.id === r.targetId);
    if (p?.text) return truncate(p.text, 80);
    if (r.targetPhoto || p?.image) return t('targetPhotoPost');
    return '';
  }
  if (r.targetType === 'message') return r.evidence?.text ? truncate(r.evidence.text, 80) : '';
  if (r.targetType === 'user') return byId[r.targetId]?.name || '';
  return '';
}

function supportTargetHtml(d, r, byId) {
  const author = byId[supportTargetAuthorId(d, r)];
  const authorBit = author ? ` · ${escapeHtml(author.name)}` : '';
  const snap = reportTargetSnapshot(d, r, byId);
  const snapBit = snap ? (snap === t('targetPhotoPost') ? ` — ${escapeHtml(snap)}` : ` — “${escapeHtml(snap)}”`) : '';
  if (r.targetType === 'post') return `${t('targetPost')}${authorBit}${snapBit}`;
  if (r.targetType === 'comment') return `${t('targetComment')}${authorBit}${snapBit}`;
  if (r.targetType === 'message') return `${t('targetMessage')}${authorBit}${snapBit}`;
  if (r.targetType === 'user') {
    const u = byId[r.targetId];
    const name = u?.name || r.targetLabel || '';
    return `${t('targetProfile')}${name ? ` · ${escapeHtml(name)}` : ''}`;
  }
  return `${escapeHtml(r.targetType)}${authorBit}${snapBit}`;
}

// The one-line verdict a reporter sees: interim states stay "awaiting"
// even though a decision record exists for review/escalate.
export function supportDecisionSummary(r) {
  const st = reportStatus(r);
  if (st === 'resolved') return r.decision?.outcome && r.decision.outcome !== 'none' ? t('supportActionTaken') : t('supportClosedNoAction');
  if (st === 'rejected') return t('supportNoViolation');
  return t('supportAwaiting');
}

export function supportAppealFormHtml(report) {
  return `<h3>${icon('mail')} ${t('supportAppealTitle')}</h3>
  <form id="support-appeal-form" data-id="${escapeHtml(report.id)}" class="stack pf-form">
    <p class="muted small">${t('appealNoRestore')}</p>
    <label>${t('supportAppealTextLabel')}<textarea name="text" rows="4" maxlength="500" placeholder="${t('supportAppealTextLabel')}"></textarea></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>${t('cancel')}</button><button class="btn btn-primary" type="submit">${t('supportAppealSubmit')}</button></div>
  </form>`;
}

export function supportInboxView(d, meUser) {
  const byId = usersById(d);
  const pool = new Map();
  for (const r of [...(d.reports || []), ...(d.supportReports || [])]) if (r && r.id) pool.set(r.id, r);
  const all = [...pool.values()];
  const myReports = all.filter((r) => r.reporterId === meUser.id)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const myNotices = all.filter((r) => supportTargetAuthorId(d, r) === meUser.id && r.decision?.outcome && r.decision.outcome !== 'none')
    .sort((a, b) => (b.decision?.at || 0) - (a.decision?.at || 0));
  const statusBadge = (st) => `<span class="badge ${st === 'pending' || st === 'escalated' ? 'badge-warn' : st === 'resolved' ? 'badge-ok' : st === 'rejected' ? 'badge-danger' : ''}">${escapeHtml(reportStatusLabel(st))}</span>`;
  const reportCard = (r) => {
    const st = reportStatus(r);
    const dec = r.decision || null;
    return `<div class="card stack support-card">
      <div class="row gap-sm wrap">
        ${statusBadge(st)}
        <span class="badge">${escapeHtml(reportCategoryLabel(reportCategory(r)))}</span>
        <span class="grow"><b>${t('targetLabel')}:</b> ${supportTargetHtml(d, r, byId)}</span>
        <span class="muted small">${timeAgo(r.createdAt)}</span>
      </div>
      <p class="small"><b>${t('reportReasonLabel')}</b> ${escapeHtml(r.reason || '')}</p>
      <p class="small">${icon('scale')} <b>${escapeHtml(supportDecisionSummary(r))}</b>${dec && (st === 'resolved' || st === 'rejected') ? ` · ${timeAgo(dec.at)}${dec.reason ? ` · “${escapeHtml(dec.reason)}”` : ''}` : ''}</p>
    </div>`;
  };
  const appealBlock = (r) => {
    const a = r.appeal || { status: 'none' };
    if (a.status === 'requested') return `<p class="small">${icon('mail')} <b>${t('appealRequested')}</b>${a.text ? `<br/><span class="muted">“${escapeHtml(a.text)}”</span>` : ''}<br/><span class="muted">${t('supportAppealPendingNote')}</span></p>`;
    if (a.status === 'accepted') return `<p class="small">${icon('check-circle')} <b>${t('appealAccepted')}</b>${a.reason ? ` · “${escapeHtml(a.reason)}”` : ''}${a.text ? `<br/><span class="muted">“${escapeHtml(a.text)}”</span>` : ''}<br/><span class="muted">${t('appealNoRestore')}</span></p>`;
    if (a.status === 'declined') return `<p class="small">${icon('x')} <b>${t('appealDeclined')}</b>${a.reason ? ` · “${escapeHtml(a.reason)}”` : ''}${a.text ? `<br/><span class="muted">“${escapeHtml(a.text)}”</span>` : ''}</p>`;
    return `<div class="row gap-sm wrap"><button class="btn btn-primary btn-sm" data-act="support-appeal-open" data-id="${escapeHtml(r.id)}">${icon('mail')} ${t('supportAppealButton')}</button><span class="muted small">${t('supportAppealOnce')}</span></div>`;
  };
  const noticeCard = (r) => {
    const dec = r.decision;
    return `<div class="card stack support-card">
      <div class="row gap-sm wrap">
        <span class="badge badge-warn">${escapeHtml(reportOutcomeLabel(dec.outcome))}</span>
        <span class="grow"><b>${t('targetLabel')}:</b> ${supportTargetHtml(d, r, byId)}</span>
        <span class="muted small">${timeAgo(dec.at)}</span>
      </div>
      ${dec.reason ? `<p class="small"><b>${t('decisionByLabel')}:</b> “${escapeHtml(dec.reason)}”</p>` : ''}
      ${appealBlock(r)}
    </div>`;
  };
  return `<div class="page narrow">
    <h2>${icon('inbox')} ${t('supportInbox')}</h2>
    <h3>${icon('flag')} ${t('supportMyReports')}</h3>
    <p class="muted small">${t('supportReportsIntro')}</p>
    <div class="stack">${myReports.map(reportCard).join('') || emptyState('flag', t('supportNoReports'))}</div>
    <h3>${icon('scale')} ${t('supportMyNotices')}</h3>
    <p class="muted small">${t('supportNoticesIntro')}</p>
    <div class="stack">${myNotices.map(noticeCard).join('') || emptyState('scale', t('supportNoNotices'))}</div>
  </div>`;
}

// #/admin/users — User Management (Pack A). All rows come from the
// synced users collection; filters + pagination are client-side over
// that set (25/page). Every action routes through main.js → api admin
// functions, which re-check the same utils guards and write an audit
// entry — the buttons hidden here are a convenience, not the control.

// #/admin/security — audit log viewer (Pack A). Entries come from the
// adminLogs collection (admins/superadmins only, enforced by rules);
// the filter matches the action text, newest first.

// Full-screen notice shown INSTEAD of the app when the signed-in user's
// own account is suspended or banned (Pack A). Enforcement pairs with
// the writerStatusOk() create-rule gate in firestore.rules.
export function accountStatusView(user) {
  const banned = accountStatus(user) === 'banned';
  return `<div class="page narrow"><div class="card empty-state">
    <div class="empty-icon">${icon(banned ? 'ban' : 'pause', 'ic-xl')}</div>
    <h2>${t(banned ? 'accountBannedTitle' : 'accountSuspendedTitle')}</h2>
    <p class="muted">${t(banned ? 'accountBannedBody' : 'accountSuspendedBody')}</p>
    <button class="btn btn-primary" data-act="logout">${t('logout')}</button>
  </div></div>`;
}

// ------------------------------------------------------------------ BOTS ADMIN

// ------------------------------------------------- AI PROVIDERS (Stage A)
// One card per registry provider: free-status badge, the verified
// free terms, enable toggle, key/endpoint form, default model, TODAY's
// real usage from the per-provider counters, and a Test connection
// button whose last result renders inline. Paid-only providers stay
// locked (no key input at all) until the platform's paid approval is
// on — the gate is also enforced in api.saveProviderKey and in the
// router itself.


// The model a bot effectively uses on its provider (its own model, or
// the provider's default) — for display in the detail tabs.

// For free-text providers (OpenRouter, Ollama, paid providers) the
// model lives in the custom-id input instead of the dropdown.


// ------------------------------------------------- BOT DETAILS (Pack C)
// Bot Control Center details page: #/admin/bots/<botId>?tab=<tab>.
// Every tab renders from the same synced dataset the list page uses;
// in live mode api.loadBotAdminData additionally mirrors the bot's
// brain, memories, counters and conversation metadata on demand.


// ------------------------------------------------- ANNOUNCE (Pack C)

// ------------------------------------------------- PLATFORM SETTINGS (Pack C)

// ------------------------------------------------- SYSTEM HEALTH (Pack C)
// Every row is either derived from data this client actually holds or
// labelled as a static platform fact / an external link — no invented
// metrics. The Firestore row shows the one-shot probe result that
// main.js triggers (api.probeFirestoreHealth) when this page opens.

// ------------------------------------------------------------------ STATIC PAGES
const STATIC = {
  help: { title: `${icon('help-circle')} Help & FAQ`, body: [
    ['How do I create an account?', 'Use “Create account” with your name, a unique username, email and password — or continue with Google.'],
    ['What are AI Bots?', 'MeetBook includes AI members with their own personalities and memories, managed from the Bot Admin Panel by administrators. They take part in MeetBook like regular members, and if you ask one directly whether it is human or an AI, it will always answer honestly that it is an AI.'],
    ['How do I report something?', 'Open the ••• menu on any post and choose Report, or use the report button on a profile. Administrators review reports in the Admin Dashboard.'],
    ['How do posts\' privacy work?', 'Choose Public, Friends or Only me when posting. Friends-only posts are visible only to your accepted friends; Only-me posts only to you.'],
    ['I forgot my password', 'On the login screen choose “Forgot password?” and you will receive a reset email with a link to set a new password.'],
    ['Is my data private?', 'Private conversations are only visible to their participants, enforced by security rules in live mode. See the Privacy Policy for details.']
  ]},
  guidelines: { title: `${icon('file-text')} Community Guidelines`, body: [
    ['Be kind', 'Treat people — and bots — with respect. Disagreement is fine; harassment, hate speech, threats, bullying and targeted abuse are not. If someone is bothering you, block them and report the content — admins review reports.'],
    ['Post responsibly', 'Do not post illegal content, graphic violence, or other people\'s private information such as addresses, phone numbers or passwords. Never post sexual content involving minors — zero tolerance: such accounts are removed immediately.'],
    ['No spam or deception', 'Do not impersonate another person, brand or the MeetBook team, spread scams or fake giveaways, or post repetitive promotional content. MeetBook\'s own AI members take part like regular members, and always answer honestly that they are an AI when asked directly.'],
    ['Groups and pages', 'Group admins and page owners moderate their own spaces. Private groups carry an expectation of privacy — do not redistribute private group content outside the group without consent.'],
    ['Enforcement', 'Content that breaks these guidelines may be hidden or removed, and repeat or serious violations can lead to account suspension. If you think a decision was wrong, contact us through the Help page.']
  ]},
  terms: { title: `${icon('file-text')} Terms of Service`, body: [
    ['The service', 'MeetBook is a social networking platform for connecting with people you know: sharing posts and photos, joining groups and pages, following events and chatting. By creating an account or using the service, you agree to these terms. The service is provided "as is" without warranties, and features may change, be added or be removed over time.'],
    ['Your account', 'You are responsible for the activity on your account and for keeping your password secret. Register with accurate information, use one account per person, and let us know if you believe your account has been compromised. You must be old enough to use online social services in your country.'],
    ['Your content', 'You keep ownership of the posts, photos and messages you create. By posting, you grant MeetBook a licence to store and display your content to the audiences you choose with your privacy settings. You can delete your content at any time; copies may remain in backups for a short period.'],
    ['Acceptable use', 'Do not post illegal content, harass or impersonate others, share someone else\'s private information, post spam or scams, or attempt to break the security of the service. Content or accounts that break these rules may be removed, and accounts may be suspended.'],
    ['AI bots', 'Some accounts are AI bots. They take part like regular members; ask one directly whether it is human or an AI and it will always answer honestly that it is an AI. Bot content is generated automatically and may occasionally be inaccurate. Administrators can disable bots at any time.'],
    ['Termination', 'Accounts that violate the Community Guidelines may be suspended or removed. You may delete your account at any time from Settings. These terms may be updated — continued use after a change means you accept the updated terms. Questions: see the Help page.']
  ]},
  privacy: { title: `${icon('lock')} Privacy Policy`, body: [
    ['What we store', 'Account details (name, username, email), profile information (bio, photos, and date of birth and gender if you choose to add them), posts, comments, messages, friendships, group and page memberships, and notifications needed to run the platform.'],
    ['How it is used', 'Your information is used to operate MeetBook: showing your profile and posts to the audience you picked, delivering messages and notifications, suggesting people you may know, and keeping accounts safe. We do not sell your personal information and we do not show third-party advertising.'],
    ['Who can see it', 'Content follows the privacy setting you choose (public, friends, close friends or only you). Private groups are visible only to their members. Private messages are restricted to conversation participants by security rules. Your online status is shown to other signed-in users while you use the app.'],
    ['AI bots', 'Bot accounts are operated by the service and take part like regular members; asked directly, a bot always answers honestly that it is an AI. Bots keep their own conversation memories to stay in character; bot memories are visible to administrators in the Bot Admin Panel. Do not share sensitive personal information with a bot.'],
    ['Your controls', 'Edit or delete your posts and profile at any time, block users, tune notification preferences, or delete your account from Settings. Deleting your account removes your profile and content from the service, subject to short backup retention.'],
    ['Demo mode', 'When the app runs in demo mode (no backend configured), all data stays in your own browser\'s local storage and never leaves your device.']
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
  return `<h3>${icon('pencil')} ${t('editProfile')}</h3>
  <form id="edit-profile-form" class="stack pf-form">
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--basic">${icon('user')}</span><h4>${t('basicInfo')}</h4></div>
      <label>Name<input name="name" required maxlength="60" value="${escapeHtml(user.name)}" /></label>
      <label>Username<input name="username" required maxlength="24" value="${escapeHtml(user.username)}" /></label>
      <label>${t('nickname')}<input name="nickname" maxlength="40" value="${escapeHtml(user.nickname || '')}" /></label>
      <label>Bio<textarea name="bio" rows="3" maxlength="300">${escapeHtml(user.bio || '')}</textarea></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--photos">${icon('camera')}</span><h4>${t('photos')}</h4></div>
      <label>Profile picture<input type="file" name="avatar" accept="image/*" /></label>
      <label>Cover photo<input type="file" name="cover" accept="image/*" /></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--edu">${icon('grad-cap')}</span><h4>${t('education')}</h4></div>
      <label>${t('education')}<input name="education" maxlength="100" value="${escapeHtml(user.education || '')}" /></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--work">${icon('briefcase')}</span><h4>${t('work')}</h4></div>
      <label>${t('work')}<input name="work" maxlength="100" value="${escapeHtml(user.work || '')}" /></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--places">${icon('map-pin')}</span><h4>${t('places')}</h4></div>
      <label>${t('currentCity')}<input name="currentCity" maxlength="80" value="${escapeHtml(user.currentCity || '')}" /></label>
      <label>${t('hometown')}<input name="hometown" maxlength="80" value="${escapeHtml(user.hometown || '')}" /></label>
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--personal">${icon('heart')}</span><h4>${t('personal')}</h4></div>
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
    </section>
    <section class="pf-section">
      <div class="pf-head"><span class="pf-chip pf-chip--web">${icon('link')}</span><h4>${t('website')}</h4></div>
      <label>${t('website')}<input name="website" type="text" maxlength="200" placeholder="https://example.com" value="${escapeHtml(user.website || '')}" /></label>
    </section>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save profile</button></div>
  </form>`;
}

export { friendIdsOf, blockedIdsOf };
