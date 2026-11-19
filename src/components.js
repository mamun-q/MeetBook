// Shared UI components: avatars, toasts, modals, post cards.
import { escapeHtml, initials, avatarColor, timeAgo, pollResults, feelingByKey } from './utils.js';
import { t } from './i18n.js';

export function toast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3600);
}

export function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-close-modal><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  root.querySelector('[data-close-modal]').addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close-modal')) closeModal();
  });
  return root.querySelector('.modal');
}

export function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

export function confirmModal(title, body) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h3>${escapeHtml(title)}</h3>
      <p class="muted">${escapeHtml(body)}</p>
      <div class="row gap end">
        <button class="btn btn-ghost" data-no>${t('cancel')}</button>
        <button class="btn btn-danger" data-yes>Confirm</button>
      </div>`);
    modal.querySelector('[data-no]').onclick = () => { closeModal(); resolve(false); };
    modal.querySelector('[data-yes]').onclick = () => { closeModal(); resolve(true); };
  });
}

// Admin confirmation dialog with an OPTIONAL reason field (Super Admin
// Pack A): resolves { confirmed: true, reason } on confirm, or null on
// cancel. The reason is stored on the audit-log entry for the action.
export function adminActionModal({ title, body = '', confirmLabel = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h3>${escapeHtml(title)}</h3>
      ${body ? `<p class="muted">${escapeHtml(body)}</p>` : ''}
      <label>${t('reasonLabel')}<input name="admin-reason" maxlength="200" placeholder="${t('reasonPlaceholder')}" autocomplete="off" /></label>
      <div class="row gap end">
        <button class="btn btn-ghost" data-no>${t('cancel')}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(confirmLabel)}</button>
      </div>`);
    modal.querySelector('[data-no]').onclick = () => { closeModal(); resolve(null); };
    modal.querySelector('[data-yes]').onclick = () => {
      const reason = modal.querySelector('[name="admin-reason"]')?.value?.trim() || '';
      closeModal();
      resolve({ confirmed: true, reason });
    };
  });
}

export function avatarHtml(user, size = 40) {
  if (!user) return '';
  if (user.avatar) return `<img class="avatar" style="width:${size}px;height:${size}px" src="${escapeHtml(user.avatar)}" alt="${escapeHtml(user.name)}" loading="lazy" />`;
  return `<span class="avatar avatar-fallback" style="width:${size}px;height:${size}px;background:${avatarColor(user.username || user.name)}" aria-hidden="true">${escapeHtml(initials(user.name))}</span>`;
}

export function userNameHtml(user) {
  if (!user) return '<span class="muted">Unknown user</span>';
  // Badges are joined with explicit spaces — concatenated badge spans
  // with nothing between them render (and extract) as one run-on word.
  // The verified ✓ (users.verified, set from Admin → Users) renders
  // everywhere names appear through this helper.
  const badges = [
    user.verified ? `<span class="badge badge-verified" title="${t('verified')}">✓</span>` : '',
    user.isBot ? `<span class="badge badge-bot" title="This is an AI bot account">${t('aiBot')}</span>` : '',
    (user.role === 'admin' || user.role === 'superadmin') ? '<span class="badge badge-admin">Admin</span>' : ''
  ].filter(Boolean).join(' ');
  return `<span class="user-name">${escapeHtml(user.name)}${badges ? ` ${badges}` : ''}</span>`;
}

// Small ✓ badge for the hand-rolled name markup in comment threads
// (kept in step with userNameHtml's verified treatment).
export function verifiedBadgeHtml(user) {
  return user?.verified ? ` <span class="badge badge-verified" title="${t('verified')}">✓</span>` : '';
}

export function postCardHtml(post, ctx) {
  const { usersById, me, friendIds } = ctx;
  const author = usersById[post.authorId];
  // Page posts render AS the page (authorId is the owner's uid; the page's
  // identity comes from ctx.pagesById, falling back to the name/avatar
  // snapshot stored on the post). Group posts get a context note linking
  // back to their group (suppressed inside the group feed itself).
  const page = post.pageId
    ? ((ctx.pagesById || {})[post.pageId] || { id: post.pageId, name: post.pageName || 'Page', avatar: post.pageAvatar || '', category: '' })
    : null;
  const group = post.groupId ? (ctx.groupsById || {})[post.groupId] : null;
  const liked = post.likes?.includes(me?.id);
  const saved = post.savedBy?.includes(me?.id);
  const myReaction = post.reactions?.[me?.id] || '';
  const reactionCounts = {};
  for (const e of Object.values(post.reactions || {})) reactionCounts[e] = (reactionCounts[e] || 0) + 1;
  // Facebook-style stats: ONE total (likes + emoji reactions) next to the
  // top reaction emojis — never a misleading "0 likes" beside reactions
  // that exist. The whole stats row hides when there is nothing to show.
  const totalReactions = (post.likes?.length || 0) + Object.keys(post.reactions || {}).length;
  const topEmojis = Object.entries(reactionCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e).join('');
  const commentTotal = (post.comments || []).reduce((n, c) => n + 1 + (c.replies || []).length, 0);
  const statsHtml = (totalReactions > 0 || commentTotal > 0 || (post.shares || 0) > 0) ? `
    <div class="post-stats muted small">
      ${totalReactions > 0 ? `<span class="stats-reactions">${topEmojis || '❤️'} ${totalReactions}</span>` : '<span></span>'}
      <span class="spacer"></span>
      ${commentTotal > 0 ? `<span>${commentTotal} ${commentTotal === 1 ? 'comment' : 'comments'}</span>` : ''}
      ${(post.shares || 0) > 0 ? `<span>${post.shares} ${post.shares === 1 ? 'share' : 'shares'}</span>` : ''}
    </div>` : '';
  const comments = (post.comments || []).map((c) => commentHtml(c, post, ctx)).join('');
  const sharedNote = post.sharedFrom ? `<div class="shared-note">🔁 Shared from ${escapeHtml(usersById[post.sharedFrom]?.name || 'a post')}</div>` : '';
  const groupNote = group && ctx.showGroupContext !== false ? `<div class="shared-note">🏘️ Posted in <a href="#/group/${group.id}">${escapeHtml(group.name)}</a></div>` : '';
  const pinnedNote = post.pinned && post.groupId ? `<div class="pinned-note">📌 ${t('announcement')}</div>` : '';
  const visIcon = post.visibility === 'friends' ? '👥' : post.visibility === 'close' ? '⭐' : (post.visibility === 'only-me' || post.visibility === 'private') ? '🔒' : '🌍';
  // Facebook-style header suffix: "— feeling grateful 🙏 at Lalbagh Fort".
  const feelingObj = feelingByKey(post.feeling);
  const feelBits = [];
  if (feelingObj) feelBits.push(`${t('feelingLabel')} ${feelingObj.label} ${feelingObj.emoji}`);
  if (post.location) feelBits.push(`at <b>${escapeHtml(post.location)}</b>`);
  const feelSuffix = feelBits.length ? ` <span class="post-feeling">— ${feelBits.join(' ')}</span>` : '';
  const authorBlock = page
    ? `<a href="#/page/${page.id}" class="row gap-sm">${avatarHtml({ name: page.name, username: page.name, avatar: page.avatar }, 44)}<span>
        <span class="user-name">${escapeHtml(page.name)} <span class="badge">${t('pageLabel')}</span></span><br/>
        <span class="muted small">${escapeHtml(page.category || t('pageLabel'))} · ${timeAgo(post.createdAt)} · ${visIcon}${post.editedAt ? ' · edited' : ''}</span>
      </span></a>`
    : `<a href="#/profile/${post.authorId}" class="row gap-sm">${avatarHtml(author, 44)}<span>
        ${userNameHtml(author)}${feelSuffix}<br/>
        <span class="muted small">@${escapeHtml(author?.username || '')} · ${timeAgo(post.createdAt)} · ${visIcon}${post.editedAt ? ' · edited' : ''}</span>
      </span></a>`;
  return `
  <article class="card post-card" data-post="${post.id}">
    ${pinnedNote}
    ${sharedNote}
    ${groupNote}
    <header class="post-head">
      ${authorBlock}
      <div class="post-menu-wrap">
        <button class="icon-btn" data-menu="${post.id}" aria-label="Post options">•••</button>
        <div class="menu hidden" id="menu-${post.id}">
          ${post.authorId === me?.id ? `<button data-act="edit-post">✏️ ${t('edit')}</button><button data-act="delete-post">🗑️ ${t('delete')}</button>` : ''}
          ${post.groupId && group?.createdBy === me?.id ? `<button data-act="toggle-pin">📌 ${post.pinned ? t('unpinAnnouncement') : t('pinAnnouncement')}</button>` : ''}
          <button data-act="save-post">${saved ? '🔖 ' + t('saved') : '🔖 ' + t('save')}</button>
          ${post.authorId !== me?.id ? `<button data-act="report-post">🚩 ${t('report')}</button>` : ''}
        </div>
      </div>
    </header>
    <p class="post-text">${linkify(post.text)}</p>
    ${post.image ? `<img class="post-image" src="${escapeHtml(post.image)}" alt="Post photo" loading="lazy" />` : ''}
    ${post.poll ? pollBlockHtml(post, me) : ''}
    ${statsHtml}
    <div class="post-actions">
      <button class="action-btn ${liked ? 'active' : ''}" data-act="like">${liked ? '❤️' : '🤍'} ${t('like')}</button>
      <button class="action-btn" data-act="focus-comment">💬 ${t('comment')}</button>
      <button class="action-btn" data-act="share">🔁 ${t('share')}</button>
      <span class="reaction-bar">
        ${['❤️', '😆', '😮', '😢', '👏'].map((e) => `<button class="reaction-btn ${myReaction === e ? 'active' : ''}" data-act="react" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}
      </span>
    </div>
    <div class="comments">${comments || '<p class="muted small">No comments yet.</p>'}</div>
    <form class="comment-form" data-comment-form="${post.id}">
      ${avatarHtml(me, 32)}
      <input name="text" placeholder="Write a comment…" autocomplete="off" maxlength="500" />
      <button class="btn btn-primary btn-sm" type="submit">${t('send')}</button>
    </form>
  </article>`;
}

// Poll block on a post card: each option is a vote button with a
// percentage bar behind it; the viewer's current choice is highlighted
// and clicking another option changes the vote (votes are a uid map).
function pollBlockHtml(post, meUser) {
  const res = pollResults(post);
  const myVote = post.poll?.votes?.[meUser?.id] || '';
  return `<div class="poll">
    ${res.options.map((o) => `<button class="poll-option ${myVote === o.id ? 'mine' : ''}" data-act="poll-vote" data-option="${o.id}" aria-pressed="${myVote === o.id}">
      <span class="poll-bar" style="width:${o.pct}%"></span>
      <span class="poll-option-text">${escapeHtml(o.text)}${myVote === o.id ? ' ✓' : ''}</span>
      <span class="poll-pct">${o.pct}%</span>
    </button>`).join('')}
    <p class="muted small poll-total">${res.totalVotes} ${t('voters')}</p>
  </div>`;
}

function commentHtml(c, post, ctx) {
  const { usersById, me } = ctx;
  const author = usersById[c.authorId];
  const replies = (c.replies || []).map((r) => {
    const ra = usersById[r.authorId];
    return `<div class="comment reply">
      ${avatarHtml(ra, 28)}
      <div class="comment-body"><b>${escapeHtml(ra?.name || '')}</b>${verifiedBadgeHtml(ra)} ${ra?.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''} ${linkify(r.text)}
      <div class="muted small">${timeAgo(r.createdAt)}${r.authorId === me?.id || post.authorId === me?.id ? ` · <button class="link-btn" data-act="delete-comment" data-comment="${r.id}">delete</button>` : ''}</div></div>
    </div>`;
  }).join('');
  return `<div class="comment">
    ${avatarHtml(author, 32)}
    <div class="comment-body">
      <b>${escapeHtml(author?.name || '')}</b>${verifiedBadgeHtml(author)} ${author?.isBot ? `<span class="badge badge-bot">${t('aiBot')}</span>` : ''} ${linkify(c.text)}
      <div class="muted small">${timeAgo(c.createdAt)} · <button class="link-btn" data-act="reply-toggle" data-comment="${c.id}">Reply</button>${c.authorId === me?.id || post.authorId === me?.id ? ` · <button class="link-btn" data-act="delete-comment" data-comment="${c.id}">delete</button>` : ''}</div>
      <form class="reply-form hidden" data-reply-form="${c.id}">
        <input name="text" placeholder="Write a reply…" autocomplete="off" maxlength="500" />
        <button class="btn btn-primary btn-sm" type="submit">${t('send')}</button>
      </form>
      ${replies}
    </div>
  </div>`;
}

export function linkify(text) {
  return escapeHtml(text || '').replace(/@([a-zA-Z0-9_.]{3,24})/g, '<span class="mention">@$1</span>');
}

export function emptyState(icon, text) {
  return `<div class="card empty-state"><div class="empty-icon">${icon}</div><p class="muted">${escapeHtml(text)}</p></div>`;
}

export function loadingHtml(text = 'Loading…') {
  return `<div class="card empty-state"><div class="spinner" aria-hidden="true"></div><p class="muted">${escapeHtml(text)}</p></div>`;
}
