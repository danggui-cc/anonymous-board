'use strict';

/**
 * 欲言信箱 —— 存储层
 *
 * 支持两种后端（自动选择）：
 *  1) LeanCloud（国内免费 BaaS，推荐用于生产部署）
 *     - 当环境变量同时配置了 LEANCLOUD_APP_ID 与 LEANCLOUD_APP_KEY 时启用
 *     - 数据存于 LeanCloud 云端，所有浏览器/设备共享，重启/重部署不丢
 *  2) 本地文件模式（file，兜底 / 本地开发）
 *     - 数据写在 DATA_DIR/data.json，仅本机可见，重部署容器会丢
 *
 * 为什么不用 MongoDB Atlas：从腾讯云 CloudBase 容器直连 AWS 上的 Atlas 数据节点
 * （*.mongodb.net）被网络层拦截（DNS 解析失败 + TLS 握手告警），实测不可用。
 * LeanCloud 为国内服务商，从 CloudBase 容器可正常连通。
 */

const fs = require('fs');
const path = require('path');

// ---------- 模式选择 ----------
const LC_APP_ID = process.env.LEANCLOUD_APP_ID;
const LC_APP_KEY = process.env.LEANCLOUD_APP_KEY; // 此处用 Master Key（服务端）
const LC_API_BASE = (process.env.LEANCLOUD_API || 'https://api.leancloud.cn').replace(/\/+$/, '');

const MODE = (LC_APP_ID && LC_APP_KEY) ? 'lc' : 'file';
const EXPLICIT_STORAGE = process.env.STORAGE || '';

// 文件模式路径
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// ===================================================================
//  LeanCloud 后端（国内免费 BaaS）
// ===================================================================

function lcHeaders() {
  return {
    'X-LC-Id': LC_APP_ID,
    'X-LC-Key': `${LC_APP_KEY},master`, // 服务端使用 Master Key，绕过 ACL
    'Content-Type': 'application/json',
  };
}

async function lcFetch(method, pathname, body) {
  const url = LC_API_BASE + '/1.1' + pathname;
  const opts = { method, headers: lcHeaders(), signal: AbortSignal.timeout(15000) };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`LeanCloud ${r.status}: ${data.error || text}`);
    err.status = r.status; err.lc = data;
    throw err;
  }
  return data;
}

async function lcQuery(className, where, order, limit = 1000) {
  const params = new URLSearchParams();
  if (where) params.set('where', JSON.stringify(where));
  if (order) params.set('order', order);
  params.set('limit', String(limit));
  const d = await lcFetch('GET', `/classes/${className}?${params.toString()}`);
  return d.results || [];
}

// 分页拉取全部（LeanCloud 单次最多 1000 条）
async function lcQueryAll(className, where, order) {
  const out = [];
  let skip = 0;
  const LIMIT = 1000;
  for (;;) {
    const params = new URLSearchParams();
    if (where) params.set('where', JSON.stringify(where));
    if (order) params.set('order', order);
    params.set('limit', String(LIMIT));
    params.set('skip', String(skip));
    const d = await lcFetch('GET', `/classes/${className}?${params.toString()}`);
    const arr = d.results || [];
    out.push(...arr);
    if (arr.length < LIMIT) break;
    skip += LIMIT;
  }
  return out;
}

async function lcCreate(className, fields) {
  const d = await lcFetch('POST', `/classes/${className}`, fields);
  return d.objectId;
}
async function lcUpdate(className, objectId, fields) {
  await lcFetch('PUT', `/classes/${className}/${objectId}`, fields);
}
async function lcDelete(className, objectId) {
  await lcFetch('DELETE', `/classes/${className}/${objectId}`);
}
async function lcGetByOurId(className, ourId) {
  const arr = await lcQuery(className, { ourId }, undefined, 1);
  return arr[0] || null;
}

function mapQuestion(q) {
  if (!q) return null;
  return {
    id: q.ourId,
    title: q.title || '',
    content: q.content || '',
    category: q.category || '其他',
    createdAt: q.createdAt || 0,
    deleteToken: q.deleteToken || '',
    author: q.author || null,
    ownerId: q.ownerId || '',
    featured: !!q.featured,
  };
}
function mapReply(r) {
  if (!r) return null;
  return {
    id: r.ourId,
    questionId: r.questionId,
    content: r.content || '',
    createdAt: r.createdAt || 0,
    quoteId: r.quoteId || null,
    rootId: r.rootId || null,
    author: r.author || null,
    deleteToken: r.deleteToken || '',
    ownerId: r.ownerId || '',
  };
}

const lcStore = {
  async init() {
    // 轻量探活：能连通即记录，失败仅告警，不影响进程
    try {
      await lcQuery('Question', undefined, undefined, 1);
      console.log('[storage] LeanCloud 连接成功（模式 lc）');
    } catch (e) {
      console.error('[storage] LeanCloud 探活失败（仅告警，进程继续）:', e && e.message);
    }
  },
  async listQuestions() {
    const arr = await lcQueryAll('Question', undefined, '-createdAt');
    return arr.map(mapQuestion);
  },
  async getQuestion(id) {
    return mapQuestion(await lcGetByOurId('Question', id));
  },
  async createQuestion(q) {
    await lcCreate('Question', {
      ourId: q.id,
      title: q.title || '',
      content: q.content || '',
      category: q.category || '其他',
      createdAt: q.createdAt || Date.now(),
      deleteToken: q.deleteToken || '',
      author: q.author || null,
      ownerId: q.ownerId || '',
      featured: false,
    });
    return q;
  },
  async deleteQuestion(id, token) {
    const q = await lcGetByOurId('Question', id);
    if (!q) return { ok: false, code: 404 };
    if (q.deleteToken !== token) return { ok: false, code: 403 };
    const reps = await lcQueryAll('Reply', { questionId: id });
    for (const r of reps) await lcDelete('Reply', r.objectId);
    await lcDelete('Question', q.objectId);
    return { ok: true };
  },
  async adminDeleteQuestion(id) {
    const q = await lcGetByOurId('Question', id);
    if (!q) return { ok: false, code: 404 };
    const reps = await lcQueryAll('Reply', { questionId: id });
    for (const r of reps) await lcDelete('Reply', r.objectId);
    await lcDelete('Question', q.objectId);
    return { ok: true };
  },
  async listReplies(qid) {
    const arr = await lcQueryAll('Reply', { questionId: qid }, 'createdAt');
    return arr.map(mapReply);
  },
  async createReply(r) {
    await lcCreate('Reply', {
      ourId: r.id,
      questionId: r.questionId,
      content: r.content || '',
      createdAt: r.createdAt || Date.now(),
      deleteToken: r.deleteToken || '',
      quoteId: r.quoteId || null,
      rootId: r.rootId || null,
      author: r.author || null,
      ownerId: r.ownerId || '',
    });
    return r;
  },
  async deleteReply(id, token) {
    const r = await lcGetByOurId('Reply', id);
    if (!r) return { ok: false, code: 404 };
    if (r.deleteToken !== token) return { ok: false, code: 403 };
    await lcDelete('Reply', r.objectId);
    return { ok: true };
  },
  async adminDeleteReply(id) {
    const r = await lcGetByOurId('Reply', id);
    if (!r) return { ok: false, code: 404 };
    await lcDelete('Reply', r.objectId);
    return { ok: true };
  },
  async setFeatured(id, val) {
    const q = await lcGetByOurId('Question', id);
    if (!q) return { ok: false, code: 404 };
    await lcUpdate('Question', q.objectId, { featured: !!val });
    return { ok: true };
  },
  async replyCounts() {
    const arr = await lcQueryAll('Reply');
    const counts = {};
    for (const r of arr) {
      if (r.questionId) counts[r.questionId] = (counts[r.questionId] || 0) + 1;
    }
    return counts;
  },
  async createUser(u) {
    const existing = await lcGetByOurId('Account', u.id);
    if (existing) return { existed: true };
    await lcCreate('Account', { ourId: u.id, salt: u.salt, pwdHash: u.pwdHash });
    return { existed: false };
  },
  async getUserSalt(id) {
    const a = await lcGetByOurId('Account', id);
    return a ? a.salt : null;
  },
  async verifyUser(id, pwdHash) {
    const a = await lcGetByOurId('Account', id);
    return !!a && a.pwdHash === pwdHash;
  },
  async listMyQuestions(ownerId) {
    const arr = await lcQueryAll('Question', { ownerId }, '-createdAt');
    return arr.map(mapQuestion);
  },
  async listMyReplies(ownerId) {
    const arr = await lcQueryAll('Reply', { ownerId }, '-createdAt');
    return arr.map(mapReply);
  },
  async debug() {
    const info = { MODE, EXPLICIT_STORAGE, mode: MODE, lcConfigured: !!(LC_APP_ID && LC_APP_KEY) };
    if (MODE === 'lc') {
      try {
        const arr = await lcQuery('Question', undefined, undefined, 1);
        const sample = await lcQuery('Reply', undefined, undefined, 1);
        info.lc = {
          ok: true,
          questionCountSample: arr.length,
          replyCountSample: sample.length,
          apiBase: LC_API_BASE,
        };
      } catch (e) {
        info.lc = { ok: false, name: e && e.name, status: e && e.status, message: e && e.message };
      }
    }
    return info;
  },
};

// ===================================================================
//  本地文件后端（file，兜底 / 本地开发）
// ===================================================================

function readFile() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { questions: [], replies: [], users: [] };
  }
}
function writeFile(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const fileStore = {
  async init() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[storage] 文件模式（mode=file），数据写入', DATA_FILE);
  },
  async listQuestions() {
    const d = readFile();
    return (d.questions || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  },
  async getQuestion(id) {
    const d = readFile();
    return d.questions.find((q) => q.id === id) || null;
  },
  async createQuestion(q) {
    const d = readFile();
    d.questions.push(q);
    writeFile(d);
    return q;
  },
  async deleteQuestion(id, token) {
    const d = readFile();
    const q = d.questions.find((x) => x.id === id);
    if (!q) return { ok: false, code: 404 };
    if (q.deleteToken !== token) return { ok: false, code: 403 };
    d.questions = d.questions.filter((x) => x.id !== id);
    d.replies = d.replies.filter((x) => x.questionId !== id);
    writeFile(d);
    return { ok: true };
  },
  async adminDeleteQuestion(id) {
    const d = readFile();
    const q = d.questions.find((x) => x.id === id);
    if (!q) return { ok: false, code: 404 };
    d.questions = d.questions.filter((x) => x.id !== id);
    d.replies = d.replies.filter((x) => x.questionId !== id);
    writeFile(d);
    return { ok: true };
  },
  async listReplies(qid) {
    const d = readFile();
    return (d.replies || []).filter((r) => r.questionId === qid).sort((a, b) => a.createdAt - b.createdAt);
  },
  async createReply(r) {
    const d = readFile();
    d.replies.push(r);
    writeFile(d);
    return r;
  },
  async deleteReply(id, token) {
    const d = readFile();
    const r = d.replies.find((x) => x.id === id);
    if (!r) return { ok: false, code: 404 };
    if (r.deleteToken !== token) return { ok: false, code: 403 };
    d.replies = d.replies.filter((x) => x.id !== id);
    writeFile(d);
    return { ok: true };
  },
  async adminDeleteReply(id) {
    const d = readFile();
    const r = d.replies.find((x) => x.id === id);
    if (!r) return { ok: false, code: 404 };
    d.replies = d.replies.filter((x) => x.id !== id);
    writeFile(d);
    return { ok: true };
  },
  async setFeatured(id, val) {
    const d = readFile();
    const q = d.questions.find((x) => x.id === id);
    if (!q) return { ok: false, code: 404 };
    q.featured = !!val;
    writeFile(d);
    return { ok: true };
  },
  async replyCounts() {
    const d = readFile();
    const counts = {};
    for (const r of d.replies || []) {
      if (r.questionId) counts[r.questionId] = (counts[r.questionId] || 0) + 1;
    }
    return counts;
  },
  async createUser(u) {
    const d = readFile();
    const existing = d.users.find((x) => x.id === u.id);
    if (existing) return { existed: true };
    d.users.push(u);
    writeFile(d);
    return { existed: false };
  },
  async getUserSalt(id) {
    const d = readFile();
    const a = d.users.find((x) => x.id === id);
    return a ? a.salt : null;
  },
  async verifyUser(id, pwdHash) {
    const d = readFile();
    const a = d.users.find((x) => x.id === id);
    return !!a && a.pwdHash === pwdHash;
  },
  async listMyQuestions(ownerId) {
    const d = readFile();
    return (d.questions || []).filter((q) => q.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async listMyReplies(ownerId) {
    const d = readFile();
    return (d.replies || []).filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async debug() {
    return { MODE, EXPLICIT_STORAGE, mode: MODE, file: DATA_FILE };
  },
};

// ---------- 导出 ----------
const store = MODE === 'lc' ? lcStore : fileStore;
store.mode = MODE;
store.init = MODE === 'lc' ? lcStore.init : fileStore.init;
module.exports = store;
