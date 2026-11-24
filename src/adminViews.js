// Admin-only HTML generators (Super Admin Control Center), split out of
// views.js so regular users never download this code: main.js loads this
// module lazily via dynamic import() the first time an #/admin/* route (or
// an admin-only modal) opens, and caches it for the session. Dependency
// direction is one-way: this module may import shared helpers from
// views.js; views.js never imports this module.
import { escapeHtml, timeAgo, truncate, isStaff, canModerate, isAdminRole, accountStatus, canManageUser, canChangeRole, ASSIGNABLE_ROLES, platformStats, analyticsSeries, spamSuspects, reportStatus, reportCategory, reportNeedsAttention, countPostComments, botConversationSummaries, recentClientErrors, REPORT_OUTCOMES } from './utils.js';
import { botModel } from './gemini.js';
import { AI_PROVIDERS, providerById, resolveAiConfig, usageTotals } from './aiProviders.js';
import { t } from './i18n.js';
import { avatarHtml, userNameHtml, emptyState } from './components.js';
import { icon, iconFill } from './icons.js';
import { firebaseReady } from './firebase.js';
import { usersById, friendIdsOfData, reportCategoryLabel, reportStatusLabel, reportOutcomeLabel, appealStatusLabel, reportTargetSnapshot } from './views.js';

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
    { key: 'overview', href: '#/admin', icon: 'bar-chart', label: t('adminOverview'), show: isStaff(meUser) },
    { key: 'analytics', href: '#/admin/analytics', icon: 'chart-line', label: t('adminAnalytics'), show: isStaff(meUser) },
    { key: 'users', href: '#/admin/users', icon: 'users', label: t('adminUsers'), show: isAdminRole(meUser) },
    { key: 'content', href: '#/admin/content', icon: 'folder', label: t('adminContent'), show: canModerate(meUser) },
    { key: 'bots', href: '#/admin/bots', icon: 'bot', label: t('adminBots'), show: isAdminRole(meUser) },
    { key: 'reports', href: '#/admin/reports', icon: 'flag', label: t('adminReports'), show: canModerate(meUser), badge: openReports },
    { key: 'announce', href: '#/admin/announce', icon: 'megaphone', label: t('adminAnnounce'), show: isAdminRole(meUser) },
    { key: 'security', href: '#/admin/security', icon: 'shield-check', label: t('adminSecurity'), show: isAdminRole(meUser) },
    { key: 'settings', href: '#/admin/settings', icon: 'settings', label: t('adminSettings'), show: isAdminRole(meUser) },
    { key: 'health', href: '#/admin/health', icon: 'activity', label: t('adminHealth'), show: isAdminRole(meUser) }
  ].filter((l) => l.show);
  return `<div class="admin-layout">
    <aside class="admin-sidebar">
      <div class="admin-side-head"><span class="admin-side-title">${icon('shield')} ${t('adminPanel')}</span><span class="badge ${meUser.role === 'superadmin' ? 'badge-superadmin' : 'badge-admin'}">${escapeHtml(roleLabel(meUser.role))}</span></div>
      <nav class="admin-nav">${links.map((l) => `<a class="admin-nav-item ${active === l.key ? 'active' : ''}" href="${l.href}"><span class="admin-nav-icon">${icon(l.icon)}</span><span class="grow">${l.label}</span>${l.badge ? `<span class="nav-badge static">${l.badge}</span>` : ''}</a>`).join('')}</nav>
      <p class="muted small admin-side-note">${escapeHtml(meUser.name)} · @${escapeHtml(meUser.username)}</p>
    </aside>
    <div class="admin-main">${content}</div>
  </div>`;
}

export function adminDeniedView() {
  return `<div class="card empty-state"><div class="empty-icon">${icon('lock', 'ic-xl')}</div><p class="muted">${t('accessDenied')}</p></div>`;
}

export function adminOverviewView(d, meUser, mode) {
  const s = platformStats(d, Date.now(), d.adminStats || null);
  const readOnly = !isAdminRole(meUser); // analysts (and moderators) get no action controls
  const note = (metric) => (mode.firebase && s.sources[metric] === 'loaded' ? ` · ${t('statFromLoaded')}` : '');
  const stat = (value, label, metric = '') => `<div class="card stat"><b>${value}</b><span>${label}${metric ? note(metric) : ''}</span></div>`;
  return `<h2>${icon('shield')} ${t('adminOverview')}</h2>
    <div class="stat-grid">
      ${stat(s.totalAccounts, `${t('statUsers')} · ${icon('user', 'ic-sm')} ${s.totalUsers} · ${icon('bot', 'ic-sm')} ${s.botAccounts}`)}
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
      <p>Mode: <b>${mode.firebase ? 'Live Supabase' : 'Demo / offline'}</b> · Project: <b>${escapeHtml(mode.projectId)}</b> · Auth: ${mode.firebase ? 'Supabase Auth' : 'Local demo accounts'} · Database: ${mode.firebase ? 'connected' : 'local store'} · Storage: ${mode.firebase ? 'Cloudinary with data-URL fallback' : 'local data URLs'}</p>
      ${readOnly ? '' : `<label class="row gap-sm"><input type="checkbox" id="maintenance-toggle" ${d.config?.maintenanceMode ? 'checked' : ''} /> <span class="grow">Maintenance mode (shows a maintenance banner to non-admin users)</span></label>
      <div class="row gap wrap"><a class="btn btn-primary btn-sm" href="#/admin/bots">${icon('bot')} Open Bot Admin Panel</a><button class="btn btn-ghost btn-sm" data-act="reset-demo">Reset demo data</button></div>`}
      <p class="muted small">Admin rights are enforced server-side: Supabase row-level security policies check the signed-in user's role on every request. This page is only the interface.</p>
    </div>`;
}

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

export function adminAnalyticsView(d, meUser, filters = {}) {
  const days = [7, 30, 90, 365].includes(Number(filters.days)) ? Number(filters.days) : 30;
  const rows = analyticsSeries(d, days);
  const rangeBtn = (n) => `<a class="btn ${n === days ? 'btn-primary' : 'btn-ghost'} btn-sm" href="#/admin/analytics?days=${n}">${t(`last${n}Days`)}</a>`;
  const chartCard = (title, body, noteText = '') => `<div class="card stack chart-card"><h3>${title}</h3>${body}${noteText ? `<p class="muted small">${noteText}</p>` : ''}</div>`;
  const tableRows = [...rows].reverse();
  return `<h2>${icon('chart-line')} ${t('adminAnalytics')}</h2>
    <div class="row gap wrap admin-filter card">
      ${rangeBtn(7)}${rangeBtn(30)}${rangeBtn(90)}${rangeBtn(365)}
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" data-act="admin-export-analytics" data-days="${days}">${icon('download')} ${t('exportCsv')}</button>
    </div>
    <p class="muted small">${t('analyticsNote')}</p>
    <div class="chart-grid">
      ${chartCard(`${icon('chart-line')} ${t('chartUserGrowth')}`, svgLine(rows, 'totalUsers'))}
      ${chartCard(`${icon('users')} ${t('chartRegistrations')}`, svgBarStack(rows, [{ key: 'registrations', color: '#1877f2', label: t('colRegistrations') }]))}
      ${chartCard(`${icon('file-text')} ${t('chartPostsPerDay')}`, svgBarStack(rows, [{ key: 'posts', color: '#2e9e5b', label: t('statPosts') }]))}
      ${chartCard(`${icon('heart')} ${t('chartEngagement')}`, svgBarStack(rows, [{ key: 'engagement', color: '#e5534b', label: t('colEngagement') }]), t('chartEngagementNote'))}
      ${chartCard(`${icon('bot')} ${t('chartBotVsHuman')}`, svgBarStack(rows, [
        { key: 'humanPosts', color: '#1877f2', label: t('colHumanPosts') },
        { key: 'botPosts', color: '#8957e5', label: t('colBotPosts') }
      ]))}
      ${chartCard(`${icon('flag')} ${t('chartReports')}`, svgBarStack(rows, [
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
        <thead><tr><th>Author</th><th>${t('statPosts')}</th><th>${icon('message-circle', 'ic-sm')}</th><th>${icon('heart', 'ic-sm')}</th><th>${t('auditTime')}</th><th>${t('actionsLabel')}</th></tr></thead>
        <tbody>${rowsPage.map((p) => { const a = byId[p.authorId]; return `<tr>
          <td><a class="row gap-sm" href="#/profile/${escapeHtml(p.authorId)}">${avatarHtml(a, 28)}<span>${escapeHtml(a?.name || '?')}</span></a>${a?.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}</td>
          <td><a href="#/profile/${escapeHtml(p.authorId)}">${escapeHtml(truncate(p.text || '', 120))}</a></td>
          <td>${countPostComments(p)}</td><td>${(p.likes || []).length}</td>
          <td>${timeAgo(p.createdAt)}</td>
          <td><button class="btn btn-danger btn-sm" data-act="admin-content-delete-post" data-id="${escapeHtml(p.id)}">${t('delete')}</button></td>
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
        <td><a class="row gap-sm" href="#/profile/${escapeHtml(entry.authorId)}">${avatarHtml(a, 28)}<span>${escapeHtml(a?.name || '?')}</span></a>${a?.isBot ? ` <span class="badge badge-bot">${t('aiBot')}</span>` : ''}</td>
        <td>${isReply ? icon('reply', 'ic-sm') + ' ' : ''}${escapeHtml(truncate(entry.text || '', 140))}</td>
        <td><a href="#/profile/${escapeHtml(post.authorId)}">${escapeHtml(truncate(post.text || '', 60))}</a> <span class="muted small">· ${escapeHtml(pa?.name || '')}</span></td>
        <td>${timeAgo(entry.createdAt)}</td>
        <td><button class="btn btn-danger btn-sm" data-act="admin-content-delete-comment" data-post="${escapeHtml(post.id)}" data-id="${escapeHtml(entry.id)}">${t('delete')}</button></td>
      </tr>`; }).join('') || `<tr><td colspan="5" class="muted center">${t('noContentFound')}</td></tr>`}</tbody>
    </table></div>
    <div class="row gap admin-pager">
      ${page > 1 ? `<a class="btn btn-ghost btn-sm" href="${pageHref(page - 1)}">${t('prevPage')}</a>` : ''}
      <span class="muted small grow center">${t('pageLabelOf')} ${page} / ${totalPages} · ${flatComments.length}</span>
      ${page < totalPages ? `<a class="btn btn-ghost btn-sm" href="${pageHref(page + 1)}">${t('nextPage')}</a>` : ''}
    </div></div>`;
  } else {
    const flagLabel = { repeat: t('flagRepeat'), links: t('flagLinks'), burst: t('flagBurst') };
    body = `<p class="muted">${icon('alert-triangle')} ${t('spamHeuristicNote')}</p>
    <div class="card stack">
      ${suspects.map(({ post, flags }) => { const a = byId[post.authorId]; return `<div class="row gap-sm wrap">
        ${avatarHtml(a, 32)}
        <span class="grow"><a href="#/profile/${escapeHtml(post.authorId)}"><b>${escapeHtml(a?.name || '?')}</b></a> · ${timeAgo(post.createdAt)}<br/><a href="#/profile/${escapeHtml(post.authorId)}">${escapeHtml(truncate(post.text || '', 160))}</a></span>
        ${flags.map((f) => `<span class="badge badge-warn">${escapeHtml(flagLabel[f] || f)}</span>`).join('')}
        <button class="btn btn-danger btn-sm" data-act="admin-content-delete-post" data-id="${escapeHtml(post.id)}">${t('delete')}</button>
      </div>`; }).join('') || `<p class="muted">${t('noContentFound')}</p>`}
    </div>`;
  }
  return `<h2>${icon('folder')} ${t('adminContent')}</h2>
    <div class="row gap wrap">
      ${tabLink('posts', `${icon('file-text')} ${t('contentPostsTab')}`, (d.posts || []).length)}
      ${tabLink('comments', `${icon('message-circle')} ${t('contentCommentsTab')}`, flatComments.length)}
      ${tabLink('spam', `${icon('shield')} ${t('contentSpamTab')}`, spamSuspects(d.posts || []).length)}
    </div>
    ${body}`;
}

export function reportResolveFormHtml(report) {
  return `<h3>${icon('check-circle')} ${t('resolveReport')}</h3>
  <form id="report-resolve-form" data-id="${escapeHtml(report.id)}" class="stack">
    <label>${t('outcomeLabel')}<select name="outcome">${REPORT_OUTCOMES.map((o) => `<option value="${o}">${escapeHtml(reportOutcomeLabel(o))}</option>`).join('')}</select></label>
    <label>${t('reasonLabel')}<input name="reason" maxlength="200" placeholder="${t('reasonPlaceholder')}" autocomplete="off" /></label>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>${t('cancel')}</button><button class="btn btn-primary" type="submit">${t('resolveReport')}</button></div>
  </form>`;
}

export function reportsView(d, meUser, filters = {}) {
  const byId = usersById(d);
  const statusF = filters.status || 'all';
  const all = [...(d.reports || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const counts = { all: all.length, pending: 0, review: 0, resolved: 0, rejected: 0, escalated: 0, appeals: 0 };
  for (const r of all) { counts[reportStatus(r)] += 1; if (r.appeal?.status === 'requested') counts.appeals += 1; }
  const list = statusF === 'all' ? all : statusF === 'appeals' ? all.filter((r) => r.appeal?.status === 'requested') : all.filter((r) => reportStatus(r) === statusF);
  const tabLink = (key, label) => `<a class="btn ${statusF === key ? 'btn-primary' : 'btn-ghost'} btn-sm" href="#/admin/reports?status=${key}">${label} (${key === 'all' ? counts.all : counts[key] || 0})</a>`;
  const statusBadge = (st) => `<span class="badge ${st === 'pending' || st === 'escalated' ? 'badge-warn' : st === 'resolved' ? 'badge-ok' : st === 'rejected' ? 'badge-danger' : ''}">${escapeHtml(reportStatusLabel(st))}</span>`;
  const targetHtml = (r) => {
    // Snapshot-first (reportTargetSnapshot): the decision may have
    // hard-deleted the target, so the live doc is only a fallback —
    // never the stats label ("Total posts"), never the raw doc id.
    const snap = reportTargetSnapshot(d, r, byId);
    const snapBit = snap ? (snap === t('targetPhotoPost') ? ` ${escapeHtml(snap)}` : ` “${escapeHtml(snap)}”`) : '';
    if (r.targetType === 'post' || r.targetType === 'comment') {
      const p = r.targetType === 'post' ? (d.posts || []).find((x) => x.id === r.targetId) : null;
      const authorId = p?.authorId || r.targetAuthorId || '';
      const a = byId[authorId];
      return `${t(r.targetType === 'post' ? 'targetPost' : 'targetComment')}:${snapBit}${a ? ` <span class="muted small">· <a href="#/profile/${authorId}">${escapeHtml(a.name)}</a></span>` : ''}`;
    }
    if (r.targetType === 'user') {
      const u = byId[r.targetId];
      return `${t('targetProfile')}: ${u ? `<a href="#/profile/${escapeHtml(u.id)}">${escapeHtml(u.name)}</a> <span class="muted small">@${escapeHtml(u.username)}</span>` : (r.targetLabel ? escapeHtml(r.targetLabel) : '<span class="muted">—</span>')}`;
    }
    if (r.targetType === 'message') {
      const sender = byId[r.evidence?.senderId];
      return `${t('targetMessage')}: ${sender ? `<a href="#/profile/${escapeHtml(sender.id)}">${escapeHtml(sender.name)}</a>` : (snap ? `“${escapeHtml(snap)}”` : '<span class="muted">—</span>')}`;
    }
    return `${escapeHtml(r.targetType)}${snapBit}`;
  };
  const card = (r) => {
    const st = reportStatus(r);
    const reporter = byId[r.reporterId];
    const dec = r.decision || null;
    // Appeal controls mirror the api guard (adminSetReportAppeal):
    // Accept/Decline render ONLY against a filed ('requested')
    // appeal; 'none' offers just Mark-requested; a decided appeal
    // shows its state line only.
    const appeal = r.appeal?.status || 'none';
    const actionable = ['pending', 'review', 'escalated'].includes(st);
    return `<div class="card stack report-card">
      <div class="row gap-sm wrap">
        ${statusBadge(st)}
        <span class="badge">${escapeHtml(reportCategoryLabel(reportCategory(r)))}</span>
        <span class="grow"><b>${t('targetLabel')}:</b> ${targetHtml(r)}</span>
        <span class="muted small">${timeAgo(r.createdAt)}</span>
      </div>
      <p class="small"><b>${t('reportedByLabel')}:</b> ${reporter ? `<a href="#/profile/${escapeHtml(reporter.id)}">${escapeHtml(reporter.name)}</a>` : escapeHtml(r.reporterId || '')} · <b>${t('reportReasonLabel')}</b> ${escapeHtml(r.reason || '')}</p>
      ${r.targetType === 'message' && r.evidence ? `<div class="evidence-box"><span class="muted small">${icon('lock', 'ic-sm')} ${t('evidenceLabel')}</span><blockquote>${escapeHtml(r.evidence.text || '')}</blockquote></div>` : ''}
      ${dec ? `<p class="small muted">${icon('scale')} ${t('decisionByLabel')}: <b>${escapeHtml(reportOutcomeLabel(dec.outcome || 'none'))}</b> · ${escapeHtml(dec.byName || '')} · ${timeAgo(dec.at)}${dec.reason ? ` · “${escapeHtml(dec.reason)}”` : ''}</p>` : ''}
      ${r.appeal?.text ? `<div class="evidence-box"><span class="muted small">${icon('mail', 'ic-sm')} ${t('supportAppealYourText')}</span><blockquote>${escapeHtml(r.appeal.text)}</blockquote></div>` : ''}
      <div class="row gap-sm wrap">
        <span class="small"><b>${t('appealLabel')}:</b> ${escapeHtml(appealStatusLabel(appeal))}</span>
        ${appeal === 'accepted' ? `<span class="muted small">${t('appealNoRestore')}</span>` : ''}
        <span class="spacer"></span>
        ${appeal === 'none' ? `<button class="btn btn-ghost btn-sm" data-act="report-appeal" data-id="${escapeHtml(r.id)}" data-appeal="requested">${t('appealMarkRequested')}</button>` : ''}
        ${appeal === 'requested' ? `<button class="btn btn-ghost btn-sm" data-act="report-appeal" data-id="${escapeHtml(r.id)}" data-appeal="accepted">${t('appealAccept')}</button>` : ''}
        ${appeal === 'requested' ? `<button class="btn btn-ghost btn-sm" data-act="report-appeal" data-id="${escapeHtml(r.id)}" data-appeal="declined">${t('appealDecline')}</button>` : ''}
      </div>
      ${actionable ? `<div class="row gap-sm wrap">
        ${st !== 'review' ? `<button class="btn btn-ghost btn-sm" data-act="report-review" data-id="${escapeHtml(r.id)}">${icon('search')} ${t('markUnderReview')}</button>` : ''}
        <button class="btn btn-primary btn-sm" data-act="report-resolve-open" data-id="${escapeHtml(r.id)}">${icon('check-circle')} ${t('resolveReport')}</button>
        <button class="btn btn-ghost btn-sm" data-act="report-reject" data-id="${escapeHtml(r.id)}">${icon('x')} ${t('rejectReport')}</button>
        ${st !== 'escalated' ? `<button class="btn btn-ghost btn-sm" data-act="report-escalate" data-id="${escapeHtml(r.id)}">${icon('arrow-up')} ${t('escalateReport')}</button>` : ''}
      </div>` : ''}
    </div>`;
  };
  return `<h2>${icon('flag')} ${t('adminReports')}</h2>
    <div class="row gap wrap">
      ${tabLink('all', t('allReports'))}
      ${tabLink('pending', t('reportStatusPending'))}
      ${tabLink('review', t('reportStatusReview'))}
      ${tabLink('resolved', t('reportStatusResolved'))}
      ${tabLink('rejected', t('reportStatusRejected'))}
      ${tabLink('escalated', t('reportStatusEscalated'))}
      ${tabLink('appeals', t('appealsTab'))}
    </div>
    <div class="stack">${list.map(card).join('') || `<div class="card empty-state"><p class="muted">${t('noContentFound')}</p></div>`}</div>`;
}

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
    if (q && !`${u.name} ${escapeHtml(u.username)} ${u.email || ''}`.toLowerCase().includes(q)) return false;
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
    if (u.isBot) return `<span class="muted small">${icon('bot')}</span>`;
    const bits = [];
    if (canManageUser(meUser, u)) {
      const st = accountStatus(u);
      if (st === 'active') bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-suspend" data-id="${escapeHtml(u.id)}">${t('suspend')}</button>`);
      if (st === 'suspended') bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-unsuspend" data-id="${escapeHtml(u.id)}">${t('unsuspend')}</button>`);
      if (st !== 'banned') bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-ban" data-id="${escapeHtml(u.id)}">${t('ban')}</button>`);
      if (st === 'banned') bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-restore" data-id="${escapeHtml(u.id)}">${t('restore')}</button>`);
      bits.push(`<button class="btn btn-ghost btn-sm" data-act="admin-user-verify" data-id="${escapeHtml(u.id)}" data-verified="${u.verified ? '0' : '1'}">${u.verified ? t('unverify') : t('verify')}</button>`);
    }
    if (canChangeRole(meUser, u)) {
      bits.push(`<button class="btn btn-danger btn-sm" data-act="admin-user-delete" data-id="${escapeHtml(u.id)}">${t('delete')}</button>`);
    }
    return bits.length ? `<div class="row gap-sm wrap">${bits.join('')}</div>` : '<span class="muted small">—</span>';
  };
  const roleCell = (u) => {
    if (canChangeRole(meUser, u)) {
      return `<select class="admin-role-select" data-id="${escapeHtml(u.id)}" aria-label="${t('roleLabel')}">${ASSIGNABLE_ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${escapeHtml(roleLabel(r))}</option>`).join('')}</select>`;
    }
    return `<span class="badge ${u.role === 'superadmin' ? 'badge-superadmin' : u.role === 'admin' ? 'badge-admin' : ''}">${escapeHtml(roleLabel(u.role))}</span>`;
  };
  return `<h2>${icon('users')} ${t('adminUsers')}</h2>
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
          <td><a class="row gap-sm" href="#/profile/${escapeHtml(u.id)}">${avatarHtml(u, 30)}<span>${userNameHtml(u)}</span></a></td>
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

export function adminSecurityView(d, meUser, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  const logs = [...(d.adminLogs || [])]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .filter((l) => !q || String(l.action || '').toLowerCase().includes(q));
  return `<h2>${icon('shield-check')} ${t('adminSecurity')}</h2>
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

export function botsView(d, meUser) {
  const globalOn = d.botSettings?.global?.enabled !== false;
  const aiCfg = resolveAiConfig(d.botSecrets || {}, d.config || {});
  const totals = usageTotals(d.aiUsage?.providers);
  return `<div class="admin-inner">
    <h2>${icon('bot')} AI Bot Admin Panel</h2>
    <div class="card stack">
      <div class="row gap wrap">
        <span class="grow"><b>Global bot kill switch</b><br/><span class="muted small">When off, no bot may post, comment, like or message — enforced in the bot engine and Cloud Functions.</span></span>
        <button class="btn ${globalOn ? 'btn-danger' : 'btn-primary'}" data-act="bot-kill-switch" data-on="${globalOn ? '0' : '1'}">${globalOn ? icon('ban') + ' Stop all bots' : iconFill('play') + ' Enable bots'}</button>
        <button class="btn btn-ghost" data-act="bot-run-cycle">${t('botRunCycle')}</button>
        <button class="btn btn-primary" data-act="bot-new">+ Create bot</button>
      </div>
      <p class="muted small">Status: <b>${globalOn ? 'ENABLED' : 'STOPPED'}</b> · ${t('aiUsageToday')}: ${totals.calls} calls · ${totals.tokens} tokens reported by providers (template fallback uses 0 provider tokens).</p>
    </div>
    ${aiProvidersSection(d, aiCfg)}
    ${firebaseReady ? `<div class="card stack">
      <h3>${icon('signal')} ${t('botRunnerTitle')}</h3>
      <p class="small"><b>${d.botRunner?.active ? t('botRunnerActive') : t('botRunnerInactive')}</b></p>
      ${d.botRunner?.lastCycleAt ? `<p class="small">${t('botLastCycle')}: ${timeAgo(d.botRunner.lastCycleAt)} — ${escapeHtml(d.botRunner.lastSummary || '')}</p>` : ''}
      ${(d.botRunner?.lastDetails || []).filter((x) => x.pendingDMs > 0).map((x) => `<p class="small">${icon('bot', 'ic-sm')} <b>${escapeHtml(x.bot)}</b>: ${escapeHtml(x.note || `${x.pendingDMs} unanswered DM(s)`)} <span class="muted">· latest unanswered ${timeAgo(x.lastUnansweredAt)}</span></p>`).join('')}
      <p class="muted small">${t('botRunnerNote')}</p>
    </div>` : ''}
    ${d.bots.map((b) => botCardHtml(d, b)).join('') || emptyState('bot', 'No bots yet. Create your first AI bot.')}
    <div class="card stack">
      <h3>Recent bot activity</h3>
      ${d.botActivities.slice(0, 15).map((a) => `<p class="small">• <b>${escapeHtml(d.bots.find((x) => x.id === a.botId)?.name || a.botId)}</b> ${escapeHtml(a.action)} — ${escapeHtml(a.detail || '')} <span class="muted">${timeAgo(a.createdAt)} · ${escapeHtml(a.status || '')}</span></p>`).join('') || '<p class="muted">No activity yet.</p>'}
      <h3>Bot logs</h3>
      ${d.botLogs.slice(0, 10).map((l) => `<p class="small mono">[${escapeHtml(l.level)}] ${escapeHtml(l.message)} <span class="muted">${timeAgo(l.createdAt)}</span></p>`).join('') || '<p class="muted">No logs.</p>'}
    </div>
  </div>`;
}

function aiProvidersSection(d, aiCfg) {
  const usage = d.aiUsage?.providers || {};
  const health = d.providerHealth || {};
  return `<div class="card stack">
      <h3>${icon('plug')} ${t('aiProvidersTitle')}</h3>
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
    ? `<form data-provider-model-form="${escapeHtml(entry.id)}" class="row gap wrap">
        <label class="grow">${t('providerDefaultModelLabel')}<select name="model">${entry.models.map((m) => `<option value="${escapeHtml(m)}" ${cfg.defaultModel === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select></label>
        <button class="btn btn-ghost" type="submit">${t('save')}</button>
      </form>`
    : `<form data-provider-model-form="${escapeHtml(entry.id)}" class="row gap wrap">
        <label class="grow">${t('providerDefaultModelLabel')}<input name="model" value="${escapeHtml(cfg.defaultModel || '')}" placeholder="${escapeHtml(entry.defaultModel || 'provider/model-id')}" /></label>
        <button class="btn btn-ghost" type="submit">${t('save')}</button>
      </form>`;
  return `<div class="card stack provider-card" data-provider="${escapeHtml(entry.id)}">
    <div class="row gap wrap">
      <span class="grow"><b>${escapeHtml(entry.label)}</b> ${badge}<br/><span class="muted small">${escapeHtml(entry.blurb)}</span></span>
      <button class="btn ${cfg.enabled !== false ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="provider-toggle" data-id="${escapeHtml(entry.id)}" data-on="${cfg.enabled !== false ? '0' : '1'}">${cfg.enabled !== false ? 'Deactivate' : 'Activate'}</button>
      <button class="btn btn-ghost btn-sm" data-act="provider-test" data-id="${escapeHtml(entry.id)}">${t('providerTestBtn')}</button>
    </div>
    <p class="muted small">${escapeHtml(entry.rpmNote)} ${entry.dailyCap != null ? `· ${t('providerDailyCap')}: ${entry.dailyCap}` : `· ${t('providerNoDailyCap')}`}</p>
    ${entry.endpointField
      ? `<p class="small">${t('providerEndpointLabel')}: <b>${escapeHtml(cfg.endpoint || entry.baseUrl)}</b></p>`
      : `<p class="small">Status: <b>${hasKey ? t('providerKeySet') : t('providerKeyNotSet')}</b></p>`}
    <p class="small">${t('providerUsageToday')}: <b>${usage.calls || 0}</b> calls · <b>${usage.promptTokens || 0}</b> prompt + <b>${usage.completionTokens || 0}</b> completion tokens · <b>${usage.errors || 0}</b> errors${(usage.calls || 0) > 0 && tokens === 0 ? ` <span class="muted">(${t('providerTokensNotReported')})</span>` : ''}</p>
    ${exhausted ? `<p class="small">${icon('alert-triangle')} ${t('providerRateLimited')}</p>` : ''}
    ${health ? `<p class="small">${t('lastTestLabel')}: <b>${health.ok ? icon('check', 'ic-sm') + ' OK' : icon('x', 'ic-sm') + ' Failed'}</b> — ${escapeHtml(health.detail || '')} <span class="muted">${timeAgo(health.at)}</span></p>` : ''}
    ${locked
      ? `<p class="muted small">${icon('lock', 'ic-sm')} ${escapeHtml(entry.paidNote || '')} ${t('providerLockedNote')}</p>`
      : entry.endpointField
        ? `<form data-provider-endpoint-form="${escapeHtml(entry.id)}" class="row gap wrap">
            <input name="endpoint" class="grow" value="${escapeHtml(cfg.endpoint || '')}" placeholder="${escapeHtml(entry.baseUrl)}" autocomplete="off" />
            <button class="btn btn-primary" type="submit">${t('save')}</button>
          </form>
          ${modelForm}`
        : `<form data-provider-key-form="${escapeHtml(entry.id)}" class="row gap wrap">
            <input type="password" name="apiKey" class="grow" placeholder="${t('providerKeyPlaceholder')}" autocomplete="off" />
            <button class="btn btn-primary" type="submit">${t('save')}</button>
            ${hasKey ? `<button class="btn btn-danger" type="button" data-act="provider-key-remove" data-id="${escapeHtml(entry.id)}">${t('geminiKeyRemove')}</button>` : ''}
          </form>
          ${modelForm}`}
  </div>`;
}

function botCardHtml(d, b) {
  const memories = d.botMemories?.[b.id] || [];
  const acts = d.botActivities.filter((a) => a.botId === b.id);
  const errors = d.botLogs.filter((l) => l.botId === b.id && l.level === 'error');
  return `<div class="card stack bot-card" data-bot="${escapeHtml(b.id)}">
    <div class="row gap wrap">
      ${avatarHtml(d.users.find((u) => u.id === b.id) || { name: b.name, username: b.username, avatar: b.avatar }, 52)}
      <div class="grow"><b>${escapeHtml(b.name)}</b> <span class="badge badge-bot">${t('aiBot')}</span> <span class="badge ${b.active ? 'badge-ok' : 'badge-warn'}">${b.active ? 'Active' : 'Inactive'}</span><br/>
      <span class="muted small">@${escapeHtml(b.username)} · traits: ${escapeHtml(b.personality.traits.join(', '))} · tone: ${escapeHtml(b.personality.tone)} · interests: ${escapeHtml(b.personality.interests.join(', '))}</span></div>
      <button class="btn btn-ghost btn-sm" data-act="bot-toggle" data-id="${escapeHtml(b.id)}">${b.active ? 'Deactivate' : 'Activate'}</button>
      <a class="btn btn-ghost btn-sm" href="#/admin/bots/${escapeHtml(b.id)}">${t('viewDetails')}</a>
      <button class="btn btn-ghost btn-sm" data-act="bot-edit" data-id="${escapeHtml(b.id)}">Configure</button>
      <button class="btn btn-danger btn-sm" data-act="bot-delete" data-id="${escapeHtml(b.id)}">${t('delete')}</button>
    </div>
    <p class="small"><b>System prompt:</b> ${escapeHtml(b.personality.systemPrompt)}</p>
    <p class="small muted">Limits/day — posts ${b.limits.postsPerDay}, comments ${b.limits.commentsPerDay}, likes ${b.limits.likesPerDay}, messages ${b.limits.messagesPerDay} · Activity records: ${acts.length} · Errors: ${errors.length}</p>
    <details><summary>Memory (${memories.length}) — this bot's own memory only</summary>
      ${memories.map((m) => `<div class="row gap-sm"><span class="grow small">${m.pinned ? iconFill('pin', 'ic-sm') + ' ' : ''}${escapeHtml(m.text)}</span><button class="btn btn-ghost btn-sm" data-act="bot-memory-delete" data-bot="${escapeHtml(b.id)}" data-id="${escapeHtml(m.id)}" aria-label="Delete memory">${icon('x')}</button></div>`).join('') || '<p class="muted small">No memories yet.</p>'}
      <form class="row gap-sm" data-bot-memory-form="${escapeHtml(b.id)}"><input name="text" class="grow" placeholder="Add a memory for this bot…" maxlength="300" /><button class="btn btn-primary btn-sm" type="submit">Add</button></form>
    </details>
  </div>`;
}

function botEffectiveModelLabel(b) {
  const entry = providerById(b?.provider);
  return (typeof b?.model === 'string' && b.model.trim()) || entry?.defaultModel || botModel(b || {});
}

function botCustomModelValue(b) {
  const entry = providerById(b?.provider);
  if (!entry?.freeText) return '';
  return typeof b?.model === 'string' ? b.model : '';
}

function botProviderSelectHtml(current = '') {
  return `<select name="provider">
    <option value="" ${!current ? 'selected' : ''}>${t('providerDefaultRouting')}</option>
    ${AI_PROVIDERS.map((p) => `<option value="${escapeHtml(p.id)}" ${current === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
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
    <p class="muted small">On MeetBook this bot appears as a regular member, with its own brain, prompt and memory. It never announces that it is an AI — but if someone asks it directly whether it is human or a bot, it always answers honestly that it is an AI.</p>
    <div class="row gap end"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${bot ? 'Save bot' : 'Create bot'}</button></div>
  </form>`;
}

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
  if (!b) return `<div class="admin-inner"><p><a href="#/admin/bots">← ${t('adminBots')}</a></p>${emptyState('bot', 'Bot not found.')}</div>`;
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
        <button class="btn ${b.active ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="bot-toggle" data-id="${escapeHtml(b.id)}">${b.active ? 'Deactivate' : 'Activate'}</button>
      </div>
      <nav class="row gap wrap bot-tabs">${BOT_DETAIL_TABS.map((key) => `<a class="btn btn-sm ${key === activeTab ? 'btn-primary' : 'btn-ghost'}" href="#/admin/bots/${escapeHtml(b.id)}?tab=${key}">${tabLabel[key]}</a>`).join('')}</nav>
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
    <h3>${icon('cpu')} ${t('tabBrain')}</h3>
    <p class="small">${t('brainProvider')}: <b>${escapeHtml(brain.provider || '—')}</b> · ${t('brainModel')}: <b>${escapeHtml(brain.model || botEffectiveModelLabel(b))}</b>${brain.updatedAt ? ` · ${t('brainUpdated')}: ${timeAgo(brain.updatedAt)}` : ''}</p>
    <form id="bot-brain-form" data-id="${escapeHtml(b.id)}" class="stack">
      <label>System prompt<textarea name="systemPrompt" rows="6" maxlength="1000">${escapeHtml(brain.systemPrompt || b.personality.systemPrompt)}</textarea></label>
      <p class="muted small">${t('brainNote')}</p>
      <div class="row gap end"><button class="btn btn-primary" type="submit">${t('brainSave')}</button></div>
    </form>
  </div>`;
}

function botTabPersonality(d, b) {
  return `<div class="card stack">
    <h3>${icon('sliders')} ${t('tabPersonality')}</h3>
    <form id="bot-personality-form" data-id="${escapeHtml(b.id)}" class="stack">
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
  // Phase 3: memories grouped by category (conversation / interest /
  // experience / fact / everything else under General).
  const cats = [
    ['conversation', ['message-circle', 'From conversations']],
    ['interest', ['star', 'Interests']],
    ['experience', ['compass', 'Experiences']],
    ['fact', ['pin', 'Facts']],
    ['general', ['folder', 'General']]
  ];
  const known = new Set(cats.map(([k]) => k));
  const catOf = (m) => (known.has(m.category) ? m.category : 'general');
  const row = (m) => `<div class="row gap-sm"><span class="grow small">${m.pinned ? iconFill('pin', 'ic-sm') + ' ' : ''}${escapeHtml(m.text)}</span><span class="muted small">${timeAgo(m.updatedAt || m.createdAt)}</span><button class="btn btn-ghost btn-sm" data-act="bot-memory-delete" data-bot="${escapeHtml(b.id)}" data-id="${escapeHtml(m.id)}" aria-label="Delete memory">${icon('x')}</button></div>`;
  const sections = cats.map(([key, [iconName, label]]) => {
    const items = memories.filter((m) => catOf(m) === key);
    return items.length ? `<h4>${icon(iconName)} ${label} (${items.length})</h4>${items.map(row).join('')}` : '';
  }).join('');
  return `<div class="card stack">
    <h3>${icon('book')} ${t('tabMemory')} (${memories.length})</h3>
    ${sections || '<p class="muted small">No memories yet.</p>'}
    <form class="row gap-sm" data-bot-memory-form="${escapeHtml(b.id)}"><input name="text" class="grow" placeholder="Add a memory for this bot…" maxlength="300" /><button class="btn btn-primary btn-sm" type="submit">Add</button></form>
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
  const decisions = (d.botDecisions?.[b.id] || []).slice(-15).reverse();
  const empty = !posts.length && !comments.length && !acts.length && !replies && !decisions.length;
  return `<div class="card stack">
    <h3>${icon('list')} ${t('tabActivity')}</h3>
    ${empty ? `<p class="muted">${t('noBotActivity')}</p>` : `
    <p class="small">${t('botRepliesLabel')}: <b>${replies}</b></p>
    ${posts.length ? `<h4>${t('recentBotPosts')}</h4>${posts.slice(0, 10).map((p) => `<p class="small">${icon('file-text', 'ic-sm')} ${escapeHtml(truncate(p.text || '', 140))} <span class="muted">${timeAgo(p.createdAt)}</span></p>`).join('')}` : ''}
    ${comments.length ? `<h4>${t('botCommentsLabel')}</h4>${comments.slice(0, 10).map(({ post, comment }) => `<p class="small">${icon('message-circle', 'ic-sm')} ${escapeHtml(truncate(comment.text || '', 140))} <span class="muted">on ${escapeHtml(byId[post.authorId]?.name || '')}'s post · ${timeAgo(comment.createdAt)}</span></p>`).join('')}` : ''}
    ${acts.length ? `<h4>Recent bot activity</h4>${acts.slice(0, 15).map((a) => `<p class="small">• ${escapeHtml(a.action)} — ${escapeHtml(a.detail || '')} <span class="muted">${timeAgo(a.createdAt)} · ${escapeHtml(a.status || '')}</span></p>`).join('')}` : ''}
    ${decisions.length ? `<h4>${icon('compass')} Decision history</h4>${decisions.map((x) => `<p class="small">• <b>${escapeHtml(x.action)}</b>${x.reason ? ` — ${escapeHtml(x.reason)}` : ''} <span class="muted">${timeAgo(x.at)}</span></p>`).join('')}` : ''}`}
  </div>`;
}

function botTabConversations(d, b) {
  const byId = usersById(d);
  const summaries = botConversationSummaries(d, b.id);
  return `<div class="card stack">
    <h3>${icon('message-circle')} ${t('tabConversations')} (${summaries.length})</h3>
    <p class="muted small">${t('conversationsMetaNote')}</p>
    ${summaries.map((s) => { const other = byId[s.otherId]; return `<div class="row gap-sm">${avatarHtml(other || { name: s.otherId || '?' }, 36)}<span class="grow"><a href="#/profile/${escapeHtml(s.otherId)}"><b>${escapeHtml(other?.name || s.otherId)}</b></a><br/><span class="muted small">${s.count} ${t('messagesCountLabel')} · ${t('lastActivityLabel')}: ${s.lastAt ? timeAgo(s.lastAt) : '—'}</span></span></div>`; }).join('') || `<p class="muted">${t('noBotActivity')}</p>`}
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
    <h3>${icon('bar-chart')} ${t('tabUsage')}</h3>
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
    <h3>${icon('settings')} ${t('tabSettings')}</h3>
    <div class="row gap wrap">
      <span class="grow"><b>${t('statusLabel')}</b><br/><span class="muted small">${b.active ? 'Active' : 'Inactive'}</span></span>
      <button class="btn ${b.active ? 'btn-danger' : 'btn-primary'}" data-act="bot-toggle" data-id="${escapeHtml(b.id)}">${b.active ? 'Deactivate' : 'Activate'}</button>
    </div>
    <form id="bot-settings-form" data-id="${escapeHtml(b.id)}" class="stack">
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
    <h3>${icon('trash')} ${t('deleteBotTitle')}</h3>
    <p class="muted small">${t('deleteBotBody')}</p>
    <div class="row gap end"><button class="btn btn-danger" data-act="bot-delete" data-id="${escapeHtml(b.id)}">${t('delete')}</button></div>
  </div>`;
}

function botTabLogs(d, b) {
  const logs = (d.botLogs || []).filter((l) => l.botId === b.id);
  return `<div class="card stack">
    <h3>${icon('terminal')} ${t('tabLogs')}</h3>
    ${logs.map((l) => `<p class="small mono">[${escapeHtml(l.level)}] ${escapeHtml(l.message)} <span class="muted">${timeAgo(l.createdAt)}</span></p>`).join('') || `<p class="muted">${firebaseReady ? t('botLogsEmptyLive') : t('botLogsEmptyDemo')}</p>`}
  </div>`;
}

export function adminAnnounceView(d, meUser) {
  const people = (d.users || []).filter((u) => !u.isBot);
  const list = [...(d.announcements || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return `<div class="admin-inner">
    <h2>${icon('megaphone')} ${t('adminAnnounce')}</h2>
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
      <h3>${icon('mail')} ${t('notifyUserTitle')}</h3>
      <form id="admin-notify-form" class="stack">
        <label>${t('notifyUserPick')}<select name="userId">${people.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)} (@${escapeHtml(u.username)})</option>`).join('')}</select></label>
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
        <button class="btn btn-ghost btn-sm" data-act="announcement-toggle" data-id="${escapeHtml(a.id)}" data-on="${a.active !== false ? '0' : '1'}">${a.active !== false ? t('announceInactive') : t('announceActive')}</button>
        <button class="btn btn-danger btn-sm" data-act="announcement-delete" data-id="${escapeHtml(a.id)}">${t('delete')}</button>
      </div>`).join('') || `<p class="muted">${t('announceEmpty')}</p>`}
    </div>
  </div>`;
}

export function adminSettingsView(d, meUser) {
  const cfg = d.config || {};
  return `<div class="admin-inner">
    <h2>${icon('settings')} ${t('adminSettings')}</h2>
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
      <h3>${icon('wrench')} Maintenance mode</h3>
      <label class="row gap-sm"><input type="checkbox" id="maintenance-toggle" ${cfg.maintenanceMode ? 'checked' : ''} /> <span class="grow">Maintenance mode (shows a maintenance banner to non-admin users)</span></label>
      <p class="muted small">${t('settingsMaintenanceNote')}</p>
    </div>
  </div>`;
}

export function adminHealthView(d, meUser, mode) {
  const probe = d.healthProbe || null;
  const s = platformStats(d, Date.now(), d.adminStats || null);
  const errors = recentClientErrors();
  const brains = (d.bots || []).map((b) => ({ bot: b, brain: d.botBrains?.[b.id] || {} }));
  const row = (label, value) => `<div class="row gap-sm"><span class="grow muted">${label}</span><span class="right">${value}</span></div>`;
  return `<div class="admin-inner">
    <h2>${icon('activity')} ${t('healthTitle')}</h2>
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
      ${row(t('healthDeploy'), `<a href="https://github.com/mamun-q/MeetBook/actions" target="_blank" rel="noopener">GitHub Actions ${icon('arrow-up-right', 'ic-sm')}</a>`)}
      <p class="muted small">${t('healthDeployNote')}</p>
      ${row(t('healthFunctions'), `<span class="muted">${t('healthFunctionsOff')}</span>`)}
      ${row(t('healthStorage'), `<span class="muted">${t('healthStorageOff')}</span>`)}
      ${row(t('healthRunner'), mode.firebase
        ? `<b>${d.botRunner?.active ? t('botRunnerActive') : t('botRunnerInactive')}</b>${d.botRunner?.lastCycleAt ? ` · ${t('botLastCycle')}: ${timeAgo(d.botRunner.lastCycleAt)}` : ''}`
        : `<span class="muted">${t('healthDemo')}</span>`)}
      ${row(t('healthGemini'), `<b>${d.botSecrets?.geminiApiKey ? t('geminiKeySet') : t('geminiKeyNotSet')}</b>`)}
      ${brains.map(({ bot, brain }) => `<div class="row gap-sm"><span class="grow muted small">${icon('bot', 'ic-sm')} ${escapeHtml(bot.name)}</span><span class="small">${escapeHtml(brain.provider || '—')} · ${escapeHtml(brain.model || botEffectiveModelLabel(bot))}${brain.updatedAt ? ` · ${timeAgo(brain.updatedAt)}` : ''}</span></div>`).join('')}
    </div>
    <div class="card stack">
      <h3>${t('healthDbCounts')}</h3>
      ${row(t('statUsers'), `<b>${s.totalAccounts}</b> <span class="muted small">(${icon('user', 'ic-sm')} ${s.totalUsers} · ${icon('bot', 'ic-sm')} ${s.botAccounts})</span>`)}
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
