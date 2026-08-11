'use strict';

const CATEGORIES = [
  '内核探寻', '审美与灵感', '创作流与技艺', '定价与价值感',
  '沟通与边界', '运营与系统', '能量与身心养护', '其他',
];
const TOKEN_KEY = 'yyx_tokens';
const LOCAL_KEY = 'yyx_local';
const OWNED_KEY = 'yyx_owned';
const SEEN_KEY = 'yyx_seen';

let MODE = 'backend';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const toast = $('#toast');
const tabs = $$('.me-tab');
const panels = $$('.me-panel');
const notifList = $('#notifList');
const myQuestionsList = $('#myQuestionsList');
const myRepliesList = $('#myRepliesList');
const uidValue = $('#uidValue');
const uidCopy = $('#uidCopy');
const setPwdPanel = $('#setPwdPanel');
const setPwdInput = $('#setPwdInput');
const setPwdConfirm = $('#setPwdConfirm');
const recoverPanel = $('#recoverPanel');
const recUidInput = $('#recUidInput');
const recPwdInput = $('#recPwdInput');
const recConfirm = $('#recConfirm');
const identityMsg = $('#identityMsg');
const adminPanel = $('#adminPanel');
const adminKeyInput = $('#adminKeyInput');
const adminUnlockBtn = $('#adminUnlock');
const adminExit = $('#adminExit');
const adminHint = $('#adminHint');

function showToast(m) { toast.textContent = m; toast.classList.remove('hidden'); clearTimeout(showToast._t); showToast._t = setTimeout(() => toast.classList.add('hidden'), 2600); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function escapeAttr(s) { return escapeHtml(s); }
function copyText(t, msg) {
  const ok = msg || '已复制';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(() => showToast(ok)).catch(() => fallbackCopy(t, ok));
  } else fallbackCopy(t, ok);
}
function fallbackCopy(t, msg) {
  const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast(msg || '已复制'); } catch (e) { showToast('复制失败，请手动复制'); }
  document.body.removeChild(ta);
}

function getTokens() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY)) || {}; } catch (e) { return {}; } }
function setToken(id, t) { const x = getTokens(); x[id] = t; localStorage.setItem(TOKEN_KEY, JSON.stringify(x)); }
function getLocal() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch (e) { return []; } }
function setLocal(a) { localStorage.setItem(LOCAL_KEY, JSON.stringify(a)); }
function makeId() { return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2)); }

function getOwned() { try { return JSON.parse(localStorage.getItem(OWNED_KEY)) || {}; } catch (e) { return {}; } }
function setOwned(id, info) { const x = getOwned(); x[id] = info; localStorage.setItem(OWNED_KEY, JSON.stringify(x)); }
function getSeen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || []; } catch (e) { return []; } }
function markSeen(ids) { const s = new Set(getSeen()); ids.forEach((i) => s.add(i)); localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); }

async function detectMode() {
  try {
    const res = await fetch('/api/questions');
    if (res.ok) { const d = await res.json(); if (Array.isArray(d.questions)) { MODE = 'backend'; return; } }
  } catch (e) {}
  MODE = 'local';
}

async function apiGetQuestionRaw(id) {
  if (MODE === 'backend') {
    try { const res = await fetch('/api/questions/' + id); if (!res.ok) return null; return res.json(); }
    catch (e) { return null; }
  }
  const q = getLocal().find((x) => x.id === id);
  if (!q) return null;
  return { question: { id: q.id, title: q.title, category: q.category, createdAt: q.createdAt }, replies: (q.replies || []).slice() };
}

async function apiList({ category, q, sort }) {
  if (MODE === 'backend') {
    const p = new URLSearchParams();
    if (category && category !== '全部') p.set('category', category);
    if (q) p.set('q', q);
    p.set('sort', sort || 'time');
    const res = await fetch('/api/questions?' + p.toString());
    const d = await res.json();
    return d.questions || [];
  }
  let arr = getLocal().slice();
  if (category && category !== '全部') arr = arr.filter((x) => x.category === category);
  if (q) { q = q.toLowerCase(); arr = arr.filter((x) => (x.title || '').toLowerCase().includes(q) || (x.content || '').toLowerCase().includes(q)); }
  arr.sort((a, b) => {
    const diff = (b.replies || []).length - (a.replies || []).length;
    if (diff !== 0) return diff;
    return b.createdAt - a.createdAt;
  });
  return arr.map((x) => ({ id: x.id, title: x.title, content: x.content, category: x.category, createdAt: x.createdAt, replyCount: (x.replies || []).length }));
}

// ---------- 消息通知 ----------
async function computeNotifications() {
  const owned = getOwned();
  const ids = Object.keys(owned);
  if (!ids.length) return [];
  const qIds = new Set();
  ids.forEach((id) => {
    const info = owned[id];
    if (info.type === 'question') qIds.add(id);
    else if (info.type === 'reply' && info.questionId) qIds.add(info.questionId);
  });
  const cache = {};
  for (const qid of qIds) cache[qid] = await apiGetQuestionRaw(qid);
  const notifs = [];
  const used = new Set();
  ids.forEach((id) => {
    const info = owned[id];
    if (info.type === 'question') {
      const d = cache[id]; if (!d) return;
      (d.replies || []).forEach((r) => {
        if (owned[r.id]) return;
        const key = 'q:' + r.id; if (used.has(key)) return; used.add(key);
        notifs.push({ kind: 'question', qid: id, qtitle: d.question.title || '（无标题）', text: r.content, time: r.createdAt, replyId: r.id });
      });
    } else if (info.type === 'reply' && info.questionId) {
      const d = cache[info.questionId]; if (!d) return;
      (d.replies || []).forEach((r) => {
        if (r.quoteId === id && !owned[r.id]) {
          const key = 'r:' + r.id; if (used.has(key)) return; used.add(key);
          notifs.push({ kind: 'reply', qid: info.questionId, qtitle: d.question.title || '（无标题）', text: r.content, time: r.createdAt, replyId: r.id });
        }
      });
    }
  });
  notifs.sort((a, b) => b.time - a.time);
  return notifs;
}

function renderNotifications() {
  computeNotifications().then((notifs) => {
    const seen = new Set(getSeen());
    markSeen(notifs.map((n) => n.replyId));
    if (!notifs.length) {
      notifList.innerHTML = '<div class="me-empty">暂无新消息<br>有人回复你的提问、或引用你的留言时，会在这里提醒你 ' + ICONS.bell + '</div>';
      return;
    }
    notifList.innerHTML = notifs.map((n) => {
      const label = n.kind === 'question' ? '有人回复了你的提问' : '有人引用了你的留言';
      const snippet = (n.text || '').slice(0, 60);
      const unread = seen.has(n.replyId) ? '' : '<span class="unread-dot">未读</span>';
      return '<a class="me-row" href="question.html?id=' + encodeURIComponent(n.qid) + '#' + encodeURIComponent(n.replyId) + '">' +
        '<div class="me-row-kind">' + label + '《' + escapeHtml(n.qtitle) + '》' + unread + '</div>' +
        '<div class="me-row-snippet">' + escapeHtml(snippet) + '</div>' +
        '<div class="me-row-meta">' + fmtDate(n.time) + '</div>' +
        '</a>';
    }).join('');
  });
}

// ---------- 我的提问 ----------
function renderMyQuestionsPanel(list) {
  if (!list.length) {
    myQuestionsList.innerHTML = '<div class="me-empty">你还没有提问<br>点击首页「＋ 我要提问」开始匿名提问 🌱</div>';
    return;
  }
  myQuestionsList.innerHTML = list.map((q) => {
    const title = q.title ? escapeHtml(q.title) : '（无标题）';
    return '<a class="me-row" href="question.html?id=' + encodeURIComponent(q.id) + '">' +
      '<div class="me-row-title">' + title + '</div>' +
      '<div class="me-row-meta">' + fmtDate(q.createdAt) + ' · ' + ICONS.chat + ' ' + (q.replyCount || 0) + ' 回复</div>' +
      '</a>';
  }).join('');
}

async function renderMyQuestions() {
  try {
    const all = await apiList({ category: '全部', q: '' });
    const owned = getOwned();
    const localMine = all.filter((q) => owned[q.id]?.type === 'question');
    let serverMine = [];
    if (MODE === 'backend') {
      const uid = YuyanIdentity.getUid();
      if (uid) {
        try {
          const res = await fetch('/api/me/questions?ownerId=' + encodeURIComponent(uid));
          if (res.ok) { const d = await res.json(); serverMine = d.questions || []; }
        } catch (e) {}
      }
    }
    const byId = new Map();
    localMine.forEach((q) => byId.set(q.id, q));
    serverMine.forEach((q) => { if (!byId.has(q.id)) byId.set(q.id, q); });
    const merged = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
    renderMyQuestionsPanel(merged);
  } catch (e) {
    myQuestionsList.innerHTML = '<div class="me-empty">加载失败，请重试</div>';
  }
}

// ---------- 我的留言 ----------
function renderMyRepliesPanel(items) {
  if (!items.length) {
    myRepliesList.innerHTML = '<div class="me-empty">你还没有留言<br>在问题详情页写下第一条回复吧 ' + ICONS.chat + '</div>';
    return;
  }
  myRepliesList.innerHTML = items.map((it) => {
    const snippet = (it.reply.content || '').slice(0, 80);
    return '<a class="me-row" href="question.html?id=' + encodeURIComponent(it.qid) + '#' + encodeURIComponent(it.reply.id) + '">' +
      '<div class="me-row-title">《' + escapeHtml(it.qtitle || '（无标题）') + '》</div>' +
      '<div class="me-row-snippet">' + escapeHtml(snippet) + '</div>' +
      '<div class="me-row-meta">' + fmtDate(it.reply.createdAt) + '</div>' +
      '</a>';
  }).join('');
}

async function renderMyReplies() {
  try {
    const owned = getOwned();
    const byQid = {};
    Object.entries(owned).forEach(([id, info]) => {
      if (info.type === 'reply' && info.questionId) {
        (byQid[info.questionId] ||= []).push(id);
      }
    });
    const items = [];
    for (const [qid, rids] of Object.entries(byQid)) {
      const d = await apiGetQuestionRaw(qid);
      if (!d) continue;
      rids.forEach((rid) => {
        const r = (d.replies || []).find((x) => x.id === rid);
        if (r) items.push({ qid, qtitle: d.question.title, reply: r });
      });
    }
    if (MODE === 'backend') {
      const uid = YuyanIdentity.getUid();
      if (uid) {
        try {
          const res = await fetch('/api/me/replies?ownerId=' + encodeURIComponent(uid));
          if (res.ok) {
            const d = await res.json();
            const replies = d.replies || [];
            const qids = [...new Set(replies.map((r) => r.questionId))];
            const cache = {};
            for (const qid of qids) cache[qid] = await apiGetQuestionRaw(qid);
            replies.forEach((r) => {
              const dd = cache[r.questionId];
              if (dd) items.push({ qid: r.questionId, qtitle: dd.question.title, reply: r });
            });
          }
        } catch (e) {}
      }
    }
    const deduped = items.filter((it, i) => items.findIndex((x) => x.reply.id === it.reply.id) === i);
    deduped.sort((a, b) => b.reply.createdAt - a.reply.createdAt);
    renderMyRepliesPanel(deduped);
  } catch (e) {
    myRepliesList.innerHTML = '<div class="me-empty">加载失败，请重试</div>';
  }
}

// ---------- 跨设备身份 ----------
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, salt) { return sha256Hex(salt + ':' + password); }
function genSalt() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function initIdentityUI() {
  const uid = YuyanIdentity.getOrCreateUid();
  uidValue.textContent = uid;
}

uidCopy.addEventListener('click', () => copyText(YuyanIdentity.getUid(), '已复制身份 ID'));

setPwdConfirm.addEventListener('click', async () => {
  const pw = setPwdInput.value;
  if (!pw || pw.length < 4) { identityMsg.textContent = '密码至少 4 位'; identityMsg.className = 'identity-msg err'; return; }
  const uid = YuyanIdentity.getOrCreateUid();
  const salt = genSalt();
  const pwdHash = await hashPassword(pw, salt);
  setPwdConfirm.disabled = true;
  try {
    const res = await fetch('/api/account/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: uid, salt, pwdHash }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { identityMsg.textContent = d.error || '设置失败'; identityMsg.className = 'identity-msg err'; return; }
    identityMsg.textContent = '已设置密码，换设备可用下方「恢复身份」找回 ✅'; identityMsg.className = 'identity-msg ok';
    setPwdInput.value = '';
    showToast('密码已设置');
  } catch (e) { identityMsg.textContent = '网络错误，请重试'; identityMsg.className = 'identity-msg err'; }
  finally { setPwdConfirm.disabled = false; }
});

recConfirm.addEventListener('click', async () => {
  const uid = recUidInput.value.trim();
  const pw = recPwdInput.value;
  if (!uid || !pw) { identityMsg.textContent = '请填写身份 ID 与密码'; identityMsg.className = 'identity-msg err'; return; }
  recConfirm.disabled = true;
  try {
    const r1 = await fetch('/api/account/salt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: uid }) });
    if (!r1.ok) { const d = await r1.json().catch(() => ({})); identityMsg.textContent = d.error || '该身份 ID 不存在'; identityMsg.className = 'identity-msg err'; return; }
    const d1 = await r1.json();
    const pwdHash = await hashPassword(pw, d1.salt);
    const r2 = await fetch('/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: uid, pwdHash }) });
    if (!r2.ok) { identityMsg.textContent = '身份 ID 或密码不正确'; identityMsg.className = 'identity-msg err'; return; }
    YuyanIdentity.setUid(uid);
    uidValue.textContent = uid;
    identityMsg.textContent = '已恢复身份，现在「我的提问 / 我的留言」包含这台设备找回的内容 ✅'; identityMsg.className = 'identity-msg ok';
    recUidInput.value = ''; recPwdInput.value = '';
    showToast('身份已恢复');
  } catch (e) { identityMsg.textContent = '网络错误，请重试'; identityMsg.className = 'identity-msg err'; }
  finally { recConfirm.disabled = false; }
});

// ---------- 管理员 ----------
function loadAdmin() {
  const ok = !!localStorage.getItem('yyx_admin');
  if (ok) enterAdminMode();
  else exitAdminMode();
}
function enterAdminMode() {
  adminPanel.classList.remove('locked');
  adminPanel.classList.add('unlocked');
  adminPanel.querySelector('.admin-label').textContent = '管理模式';
  adminKeyInput.value = '';
  adminHint.innerHTML = '已解锁 ' + ICONS.shield + ' 回到首页后，问题卡片右上角会显示「管理」按钮。';
}
function exitAdminMode() {
  localStorage.removeItem('yyx_admin');
  adminPanel.classList.remove('unlocked');
  adminPanel.classList.add('locked');
  adminPanel.querySelector('.admin-label').textContent = '管理员口令';
  adminHint.innerHTML = '解锁后，首页的问题卡片右上角会显示「' + ICONS.shield + ' 管理」按钮。';
}
async function adminUnlock() {
  const key = adminKeyInput.value.trim();
  if (!key) { showToast('请输入口令'); return; }
  if (MODE === 'backend') {
    try {
      const res = await fetch('/api/admin/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      if (!res.ok) { showToast('口令错误'); return; }
    } catch (e) { showToast('验证失败'); return; }
  }
  localStorage.setItem('yyx_admin', key);
  enterAdminMode();
  showToast('已进入管理模式');
}
adminUnlockBtn.addEventListener('click', adminUnlock);
adminExit.addEventListener('click', exitAdminMode);
adminKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') adminUnlock(); });

// ---------- 标签页 ----------
function switchTab(name) {
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  panels.forEach((p) => p.classList.toggle('hidden', p.id !== 'panel-' + name));
  localStorage.setItem('yyx_me_tab', name);
  if (name === 'notifications') renderNotifications();
  if (name === 'questions') renderMyQuestions();
  if (name === 'replies') renderMyReplies();
}

tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ---------- 启动 ----------
(async function start() {
  YuyanIdentity.getOrCreateUid();
  initIdentityUI();
  await detectMode();
  loadAdmin();
  const hash = location.hash.replace('#', '');
  const saved = localStorage.getItem('yyx_me_tab');
  const initial = ['notifications', 'questions', 'replies', 'identity', 'admin'].includes(hash) ? hash : (saved || 'notifications');
  switchTab(initial);
})();
