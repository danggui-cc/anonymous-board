'use strict';

/**
 * 欲言信箱 —— 存储层（双模式）
 *
 *  - 文件模式（file）：本地 / 无云环境时使用，数据写入 data/data.json
 *  - 云数据库模式（tcb）：部署到腾讯云 CloudBase（云托管 / 云函数）时使用
 *    自带的 NoSQL 云数据库，数据持久、重启不丢，不依赖 COS 挂载（cosfs）
 *
 * 模式选择：
 *  - 显式：环境变量 STORAGE=file | tcb
 *  - 自动：检测到云托管 / 云函数环境特征（TCB_ENV / SCF_NAMESPACE /
 *          TENCENTCLOUD_RUNENV）时自动走 tcb，否则走 file
 *
 * 对外全部为 async 方法，server.js 无需关心底层实现。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function detectMode() {
  if (process.env.STORAGE === 'file') return 'file';
  if (process.env.STORAGE === 'tcb') return 'tcb';
  if (process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.TENCENTCLOUD_RUNENV) return 'tcb';
  return 'file';
}
const MODE = detectMode();
// 用户是否显式指定了 STORAGE（env / Dockerfile）。
// 显式指定 tcb 时，绝不降级到 file，避免数据写到临时容器里随重启丢失。
const EXPLICIT_STORAGE = !!process.env.STORAGE;
function allowFallback() { return !(MODE === 'tcb' && EXPLICIT_STORAGE); }

// ---------------- 文件模式（本地兜底） ----------------
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ questions: [], replies: [] }, null, 2));
  }
}
function readStore() {
  ensureStore();
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(s.questions)) s.questions = [];
    if (!Array.isArray(s.replies)) s.replies = [];
    return s;
  } catch (e) {
    return { questions: [], replies: [] };
  }
}
function writeStore(store) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// 用户账号（跨设备身份）本地兜底存储 —— 仅本地模式使用，云数据库模式走 users 集合
const USERS_FILE = path.join(DATA_DIR, 'users.json');
function readUsers() {
  ensureStore();
  try { const s = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); return Array.isArray(s) ? s : []; }
  catch (e) { return []; }
}
function writeUsers(arr) { ensureStore(); fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2)); }

// ---------------- 云数据库模式（CloudBase） ----------------
let _db = null;
let _tcbHealthy = null; // null = 未探测，true/false = 探测结果

function getDB() {
  if (_db) return _db;
  // 懒加载：file 模式下永远不会 require，避免无谓依赖
  const tcb = require('@cloudbase/node-sdk');
  const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
  _db = app.database();
  return _db;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label || '操作'} 超时 (${ms}ms)`)), ms)
    ),
  ]);
}

// 故障自愈：探测失败后，过一段时间把 _tcbHealthy 重置为 null，
// 让后续请求重新探测（比如用户在控制台补建了集合 / 修正了权限后自动恢复，
// 不必重新部署）。用 _retryScheduled 防止定时器堆积。
let _retryScheduled = false;
function scheduleRetry() {
  if (_retryScheduled) return;
  _retryScheduled = true;
  setTimeout(() => { _tcbHealthy = null; _retryScheduled = false; }, 30000);
}

// 探测云数据库是否真正可用（避免 tcb 初始化后调用永远挂起导致 API 无响应）
async function probeTcbHealth() {
  if (_tcbHealthy !== null) return _tcbHealthy;
  if (MODE !== 'tcb') { _tcbHealthy = false; return false; }
  try {
    const db = getDB();
    await withTimeout(db.collection('questions').limit(1).get(), 5000, 'tcb 健康探测');
    _tcbHealthy = true;
    console.log('[storage] 云数据库探测成功，使用 tcb 模式');
    return true;
  } catch (e) {
    _tcbHealthy = false;
    scheduleRetry();
    if (!allowFallback()) {
      console.error('[storage] 显式配置 STORAGE=tcb，但云数据库探测失败:', e && e.message);
      throw new Error('STORAGE=tcb 配置下无法连接 CloudBase 云数据库，请检查集合/权限/网络。错误：' + (e && e.message));
    }
    console.warn('[storage] 云数据库探测失败，已降级为 file 模式（数据会写在容器内，重启丢失）:', e && e.message);
    return false;
  }
}

// 一次性尝试创建集合（权限不足时静默失败，由用户在控制台手动建）
let _ensured = false;
async function ensureCollections() {
  if (_ensured) return;
  _ensured = true;
  if (MODE !== 'tcb') return;
  try {
    const db = getDB();
    // 先创建集合（幂等：已存在则静默失败）。不要依赖"先探测成功"——
    // 否则"集合不存在→探测失败→永不建集合"会陷入死锁。
    await withTimeout(db.createCollection('questions'), 5000, 'createCollection questions').catch(() => {});
    await withTimeout(db.createCollection('replies'), 5000, 'createCollection replies').catch(() => {});
    await withTimeout(db.createCollection('users'), 5000, 'createCollection users').catch(() => {});
    // 再探测连通性（失败不影响端口监听，由 30s 重试自愈）
    await probeTcbHealth();
  } catch (e) {
    console.error('[storage] 初始化/探测失败，端口仍正常监听，将自动重试:', e && e.message);
  }
}

// 当前实际生效的存储模式
function activeMode() {
  if (MODE !== 'tcb') return 'file';
  if (!EXPLICIT_STORAGE) return _tcbHealthy === true ? 'tcb' : 'file';
  return 'tcb';
}

// ---------------- 统一存储接口 ----------------
const store = {
  // 返回当前实际生效的存储模式
  get mode() { return activeMode(); },

  // 启动时可调用：确保集合存在（仅 tcb 模式有效，失败不致命）
  async init() { await ensureCollections(); },

  async listQuestions() {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('questions').limit(1000).get(), 10000, 'listQuestions');
        return res.data || [];
      } catch (e) {
        console.warn('[storage] listQuestions tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    return readStore().questions.slice();
  },

  async getQuestion(id) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('questions').doc(id).get(), 8000, 'getQuestion');
        return (res.data && res.data[0]) || null;
      } catch (e) {
        console.warn('[storage] getQuestion tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    return readStore().questions.find((p) => p.id === id) || null;
  },

  async createQuestion(q) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        await withTimeout(db.collection('questions').doc(q.id).set(q), 8000, 'createQuestion');
        return q;
      } catch (e) {
        console.warn('[storage] createQuestion tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const s = readStore();
    s.questions.push(q);
    writeStore(s);
    return q;
  },

  // 返回 { ok:boolean, code:404|403 }
  async deleteQuestion(id, token) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('questions').doc(id).get(), 8000, 'deleteQuestion.get');
        const q = res.data && res.data[0];
        if (!q) return { ok: false, code: 404 };
        if (q.deleteToken !== token) return { ok: false, code: 403 };
        await withTimeout(db.collection('questions').doc(id).remove(), 8000, 'deleteQuestion.remove');
        await withTimeout(db.collection('replies').where({ questionId: id }).remove(), 8000, 'deleteQuestion.removeReplies');
        return { ok: true };
      } catch (e) {
        console.warn('[storage] deleteQuestion tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const s = readStore();
    const idx = s.questions.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    if (s.questions[idx].deleteToken !== token) return { ok: false, code: 403 };
    s.replies = s.replies.filter((r) => r.questionId !== id);
    s.questions.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },

  async adminDeleteQuestion(id) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('questions').doc(id).get(), 8000, 'adminDeleteQuestion.get');
        if (!(res.data && res.data[0])) return { ok: false, code: 404 };
        await withTimeout(db.collection('questions').doc(id).remove(), 8000, 'adminDeleteQuestion.remove');
        await withTimeout(db.collection('replies').where({ questionId: id }).remove(), 8000, 'adminDeleteQuestion.removeReplies');
        return { ok: true };
      } catch (e) {
        console.warn('[storage] adminDeleteQuestion tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const s = readStore();
    const idx = s.questions.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    s.replies = s.replies.filter((r) => r.questionId !== id);
    s.questions.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },

  // 设置问题精选状态（管理员）。val 为 boolean
  async setFeatured(id, val) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('questions').doc(id).get(), 8000, 'setFeatured.get');
        if (!(res.data && res.data[0])) return { ok: false, code: 404 };
        await withTimeout(db.collection('questions').doc(id).update({ featured: !!val }), 8000, 'setFeatured.update');
        return { ok: true };
      } catch (e) {
        console.warn('[storage] setFeatured tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const s = readStore();
    const q = s.questions.find((p) => p.id === id);
    if (!q) return { ok: false, code: 404 };
    q.featured = !!val;
    writeStore(s);
    return { ok: true };
  },

  async listReplies(questionId) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('replies').where({ questionId }).get(), 8000, 'listReplies');
        return (res.data || []).sort((a, b) => a.createdAt - b.createdAt);
      } catch (e) {
        console.warn('[storage] listReplies tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    return readStore().replies
      .filter((r) => r.questionId === questionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async createReply(reply) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        await withTimeout(db.collection('replies').doc(reply.id).set(reply), 8000, 'createReply');
        return reply;
      } catch (e) {
        console.warn('[storage] createReply tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const s = readStore();
    s.replies.push(reply);
    writeStore(s);
    return reply;
  },

  // 返回 { ok:boolean, code:404|403 }
  async deleteReply(id, token) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('replies').doc(id).get(), 8000, 'deleteReply.get');
        const r = res.data && res.data[0];
        if (!r) return { ok: false, code: 404 };
        if (r.deleteToken !== token) return { ok: false, code: 403 };
        await withTimeout(db.collection('replies').doc(id).remove(), 8000, 'deleteReply.remove');
        return { ok: true };
      } catch (e) {
        console.warn('[storage] deleteReply tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const s = readStore();
    const idx = s.replies.findIndex((r) => r.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    if (s.replies[idx].deleteToken !== token) return { ok: false, code: 403 };
    s.replies.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },

  async adminDeleteReply(id) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('replies').doc(id).get(), 8000, 'adminDeleteReply.get');
        if (!(res.data && res.data[0])) return { ok: false, code: 404 };
        await withTimeout(db.collection('replies').doc(id).remove(), 8000, 'adminDeleteReply.remove');
        return { ok: true };
      } catch (e) {
        console.warn('[storage] adminDeleteReply tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const s = readStore();
    const idx = s.replies.findIndex((r) => r.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    s.replies.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },

  // 各问题的回复数 map：{ questionId: count }
  async replyCounts() {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('replies').limit(1000).get(), 8000, 'replyCounts');
        const rc = {};
        (res.data || []).forEach((r) => { rc[r.questionId] = (rc[r.questionId] || 0) + 1; });
        return rc;
      } catch (e) {
        console.warn('[storage] replyCounts tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const s = readStore();
    const rc = {};
    s.replies.forEach((r) => { rc[r.questionId] = (rc[r.questionId] || 0) + 1; });
    return rc;
  },

  // ---------- 用户账号（跨设备身份）----------
  // 返回全部回复（不分问题），用于按 ownerId 聚合"我的留言"
  async listAllReplies() {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('replies').limit(1000).get(), 10000, 'listAllReplies');
        return res.data || [];
      } catch (e) {
        console.warn('[storage] listAllReplies tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    return readStore().replies.slice();
  },

  // 创建账号（仅当 id 不存在时写入）。user: { id, salt, pwdHash }
  async createUser(user) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('users').doc(user.id).get(), 8000, 'getUser');
        if (res.data && res.data[0]) return { ok: true, existed: true };
        await withTimeout(db.collection('users').doc(user.id).set(user), 8000, 'createUser');
        return { ok: true, existed: false };
      } catch (e) {
        console.warn('[storage] createUser tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const arr = readUsers();
    if (arr.find((u) => u.id === user.id)) return { ok: true, existed: true };
    arr.push(user); writeUsers(arr);
    return { ok: true, existed: false };
  },

  // 取某用户的盐（公开，供前端计算登录哈希）。不存在返回 null
  async getUserSalt(id) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('users').doc(id).get(), 8000, 'getUserSalt');
        const u = res.data && res.data[0];
        return u ? u.salt : null;
      } catch (e) {
        console.warn('[storage] getUserSalt tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const u = readUsers().find((x) => x.id === id);
    return u ? u.salt : null;
  },

  // 校验密码哈希。返回 boolean
  async verifyUser(id, pwdHash) {
    if (await probeTcbHealth()) {
      try {
        const db = getDB();
        const res = await withTimeout(db.collection('users').doc(id).get(), 8000, 'verifyUser');
        const u = res.data && res.data[0];
        return !!(u && u.pwdHash === pwdHash);
      } catch (e) {
        console.warn('[storage] verifyUser tcb 失败:', e && e.message);
        if (!allowFallback()) throw e;
      }
    }
    if (!allowFallback()) throw new Error('当前强制使用 tcb 模式，但云数据库不可用');
    const u = readUsers().find((x) => x.id === id);
    return !!(u && u.pwdHash === pwdHash);
  },

  // 按 ownerId 列出"我的提问"（含回复数）
  async listMyQuestions(ownerId) {
    const all = await store.listQuestions();
    const rc = await store.replyCounts();
    return all
      .filter((p) => p.ownerId === ownerId)
      .map((p) => ({
        id: p.id, title: p.title, content: p.content, category: p.category,
        createdAt: p.createdAt, author: p.author || null, replyCount: rc[p.id] || 0,
      }));
  },

  // 按 ownerId 列出"我的留言"（含所属 questionId，供前端补足标题）
  async listMyReplies(ownerId) {
    const all = await store.listAllReplies();
    return (all || [])
      .filter((r) => r.ownerId === ownerId)
      .map((r) => ({
        id: r.id, content: r.content, createdAt: r.createdAt, questionId: r.questionId,
        quoteId: r.quoteId || null, rootId: r.rootId || null, author: r.author || null,
      }));
  },
};

module.exports = store;
