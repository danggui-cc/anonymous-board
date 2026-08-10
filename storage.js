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

// ---------------- 云数据库模式（CloudBase） ----------------
let _db = null;
function getDB() {
  if (_db) return _db;
  // 懒加载：file 模式下永远不会 require，避免无谓依赖
  const tcb = require('@cloudbase/node-sdk');
  const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
  _db = app.database();
  return _db;
}

// 一次性尝试创建集合（权限不足时静默失败，由用户在控制台手动建）
let _ensured = false;
async function ensureCollections() {
  if (_ensured) return;
  _ensured = true;
  if (MODE !== 'tcb') return;
  try {
    const db = getDB();
    await db.createCollection('questions').catch(() => {});
    await db.createCollection('replies').catch(() => {});
  } catch (e) { /* 忽略，控制台手动创建亦可 */ }
}

// ---------------- 统一存储接口 ----------------
const store = {
  mode: MODE,

  // 启动时可调用：确保集合存在（仅 tcb 模式有效，失败不致命）
  async init() { await ensureCollections(); },

  async listQuestions() {
    if (MODE === 'tcb') {
      const db = getDB();
      const res = await db.collection('questions').limit(1000).get();
      return res.data || [];
    }
    return readStore().questions.slice();
  },

  async getQuestion(id) {
    if (MODE === 'tcb') {
      const db = getDB();
      const res = await db.collection('questions').doc(id).get();
      return (res.data && res.data[0]) || null;
    }
    return readStore().questions.find((p) => p.id === id) || null;
  },

  async createQuestion(q) {
    if (MODE === 'tcb') {
      const db = getDB();
      await db.collection('questions').doc(q.id).set(q);
      return q;
    }
    const s = readStore();
    s.questions.push(q);
    writeStore(s);
    return q;
  },

  // 返回 { ok:boolean, code:404|403 }
  async deleteQuestion(id, token) {
    if (MODE === 'tcb') {
      const db = getDB();
      const res = await db.collection('questions').doc(id).get();
      const q = res.data && res.data[0];
      if (!q) return { ok: false, code: 404 };
      if (q.deleteToken !== token) return { ok: false, code: 403 };
      await db.collection('questions').doc(id).remove();
      await db.collection('replies').where({ questionId: id }).remove();
      return { ok: true };
    }
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
    if (MODE === 'tcb') {
      const db = getDB();
      const res = await db.collection('questions').doc(id).get();
      if (!(res.data && res.data[0])) return { ok: false, code: 404 };
      await db.collection('questions').doc(id).remove();
      await db.collection('replies').where({ questionId: id }).remove();
      return { ok: true };
    }
    const s = readStore();
    const idx = s.questions.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    s.replies = s.replies.filter((r) => r.questionId !== id);
    s.questions.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },

  async listReplies(questionId) {
    if (MODE === 'tcb') {
      const db = getDB();
      const res = await db.collection('replies').where({ questionId }).get();
      return (res.data || []).sort((a, b) => a.createdAt - b.createdAt);
    }
    return readStore().replies
      .filter((r) => r.questionId === questionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async createReply(reply) {
    if (MODE === 'tcb') {
      const db = getDB();
      await db.collection('replies').doc(reply.id).set(reply);
      return reply;
    }
    const s = readStore();
    s.replies.push(reply);
    writeStore(s);
    return reply;
  },

  // 返回 { ok:boolean, code:404|403 }
  async deleteReply(id, token) {
    if (MODE === 'tcb') {
      const db = getDB();
      const res = await db.collection('replies').doc(id).get();
      const r = res.data && res.data[0];
      if (!r) return { ok: false, code: 404 };
      if (r.deleteToken !== token) return { ok: false, code: 403 };
      await db.collection('replies').doc(id).remove();
      return { ok: true };
    }
    const s = readStore();
    const idx = s.replies.findIndex((r) => r.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    if (s.replies[idx].deleteToken !== token) return { ok: false, code: 403 };
    s.replies.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },

  async adminDeleteReply(id) {
    if (MODE === 'tcb') {
      const db = getDB();
      const res = await db.collection('replies').doc(id).get();
      if (!(res.data && res.data[0])) return { ok: false, code: 404 };
      await db.collection('replies').doc(id).remove();
      return { ok: true };
    }
    const s = readStore();
    const idx = s.replies.findIndex((r) => r.id === id);
    if (idx === -1) return { ok: false, code: 404 };
    s.replies.splice(idx, 1);
    writeStore(s);
    return { ok: true };
  },

  // 各问题的回复数 map：{ questionId: count }
  async replyCounts() {
    if (MODE === 'tcb') {
      const db = getDB();
      const res = await db.collection('replies').limit(1000).get();
      const rc = {};
      (res.data || []).forEach((r) => { rc[r.questionId] = (rc[r.questionId] || 0) + 1; });
      return rc;
    }
    const s = readStore();
    const rc = {};
    s.replies.forEach((r) => { rc[r.questionId] = (rc[r.questionId] || 0) + 1; });
    return rc;
  },
};

module.exports = store;
