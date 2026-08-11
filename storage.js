'use strict';

/**
 * 欲言信箱 —— 存储层
 *
 * 支持两种后端（自动选择）：
 *  1) 腾讯云 COS 对象存储（推荐用于生产部署，零成本、无需数据库密码）
 *     - 当环境变量配置了 COS_SECRET_ID + COS_SECRET_KEY + COS_BUCKET 时启用
 *     - 数据整体存于一个 COS 对象（默认 yuyan/data.json），所有浏览器/设备共享，
 *       重启/重部署不丢；后端 server.js 通过内网直连 COS，前端无需直连、无需配 CORS。
 *     - 读写模式：read（下载对象）→ modify（内存改）→ write（覆盖上传），
 *       带 5 次重试缓解并发覆盖；数据量极小（KB 级），请求费可忽略。
 *  2) 本地文件模式（file，兜底 / 本地开发）
 *     - 数据写在 DATA_DIR/data.json，仅本机可见，重部署容器会丢。
 *
 * 放弃的方案（仅作记录，勿回退）：
 *  - LeanCloud 国内版：已停止新用户注册、即将下线。
 *  - MongoDB Atlas（AWS 境外）：从 CloudBase 容器直连 *.mongodb.net 被网络层拦截
 *    （DNS 解析失败 + TLS 握手告警），实测不可用。
 *  - 腾讯云 TencentDB for MongoDB：可行但需付费 + 内网互联，用户选择免费 COS。
 *  - CloudBase SQL 型数据库（PostgreSQL）：共享集群模式密码不可见、外网不可开，
 *    无法直连用 pg 驱动，走不通。
 *  - CloudBase 自带文档型数据库 / @cloudbase/node-sdk：云托管不注入凭据
 *    （TCB_ENV 等全 false），node-sdk 无法初始化，走不通。
 */

const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');

// ---------- 模式选择 ----------
const COS_SECRET_ID = process.env.COS_SECRET_ID || '';
const COS_SECRET_KEY = process.env.COS_SECRET_KEY || '';
const COS_BUCKET = process.env.COS_BUCKET || '';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_KEY = process.env.COS_KEY || 'yuyan/data.json';
const EXPLICIT_STORAGE = process.env.STORAGE || '';

const MODE = (EXPLICIT_STORAGE === 'file')
  ? 'file'
  : (COS_SECRET_ID && COS_SECRET_KEY && COS_BUCKET ? 'cos' : 'file');

// 文件模式路径
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// ===================================================================
//  腾讯云 COS 后端（零成本对象存储）
// ===================================================================

let _cos = null;
function getCos() {
  if (_cos) return _cos;
  _cos = new COS({
    SecretId: COS_SECRET_ID,
    SecretKey: COS_SECRET_KEY,
  });
  return _cos;
}

function emptyData() {
  return { questions: [], replies: [], users: [] };
}

// 下载对象并解析 JSON；对象不存在 / 解析失败 → 返回空结构
function readRemote() {
  return new Promise((resolve) => {
    getCos().getObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: COS_KEY,
    }, (err, data) => {
      if (err) return resolve(emptyData());
      try {
        const text = data.Body && data.Body.toString ? data.Body.toString('utf8') : '{}';
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return resolve(emptyData());
        return resolve({
          questions: Array.isArray(parsed.questions) ? parsed.questions : [],
          replies: Array.isArray(parsed.replies) ? parsed.replies : [],
          users: Array.isArray(parsed.users) ? parsed.users : [],
        });
      } catch {
        return resolve(emptyData());
      }
    });
  });
}

// 上传覆盖（整个对象替换，写操作原子）
function writeRemote(obj) {
  const body = JSON.stringify(obj, null, 2);
  return new Promise((resolve, reject) => {
    getCos().putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: COS_KEY,
      Body: body,
      ContentType: 'application/json',
    }, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

// 读 → 改(d 由 mutate 原地修改) → 写；失败重试最多 5 次，缓解并发覆盖
async function withData(mutate) {
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    const data = await readRemote();
    result = await mutate(data);
    try {
      await writeRemote(data);
      return result;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return result;
}

const cosStore = {
  async init() {
    try {
      await new Promise((resolve, reject) => {
        getCos().headBucket({ Bucket: COS_BUCKET, Region: COS_REGION }, (err, data) => {
          if (err) return reject(err);
          resolve(data);
        });
      });
      console.log('[storage] COS 连接成功（模式 cos）');
    } catch (e) {
      console.error('[storage] COS 探活失败（仅告警，进程继续）:', e && e.message);
    }
  },
  async listQuestions() {
    const d = await readRemote();
    return d.questions.slice().sort((a, b) => b.createdAt - a.createdAt);
  },
  async getQuestion(id) {
    const d = await readRemote();
    return d.questions.find((q) => q.id === id) || null;
  },
  async createQuestion(q) {
    await withData((d) => { d.questions.push(q); });
    return q;
  },
  async deleteQuestion(id, token) {
    let res = { ok: false, code: 404 };
    await withData((d) => {
      const q = d.questions.find((x) => x.id === id);
      if (!q) { res = { ok: false, code: 404 }; return; }
      if (q.deleteToken !== token) { res = { ok: false, code: 403 }; return; }
      d.questions = d.questions.filter((x) => x.id !== id);
      d.replies = d.replies.filter((x) => x.questionId !== id);
      res = { ok: true };
    });
    return res;
  },
  async adminDeleteQuestion(id) {
    let res = { ok: false, code: 404 };
    await withData((d) => {
      const q = d.questions.find((x) => x.id === id);
      if (!q) { res = { ok: false, code: 404 }; return; }
      d.questions = d.questions.filter((x) => x.id !== id);
      d.replies = d.replies.filter((x) => x.questionId !== id);
      res = { ok: true };
    });
    return res;
  },
  async listReplies(qid) {
    const d = await readRemote();
    return d.replies.filter((r) => r.questionId === qid).sort((a, b) => a.createdAt - b.createdAt);
  },
  async createReply(r) {
    await withData((d) => { d.replies.push(r); });
    return r;
  },
  async deleteReply(id, token) {
    let res = { ok: false, code: 404 };
    await withData((d) => {
      const r = d.replies.find((x) => x.id === id);
      if (!r) { res = { ok: false, code: 404 }; return; }
      if (r.deleteToken !== token) { res = { ok: false, code: 403 }; return; }
      d.replies = d.replies.filter((x) => x.id !== id);
      res = { ok: true };
    });
    return res;
  },
  async adminDeleteReply(id) {
    let res = { ok: false, code: 404 };
    await withData((d) => {
      const r = d.replies.find((x) => x.id === id);
      if (!r) { res = { ok: false, code: 404 }; return; }
      d.replies = d.replies.filter((x) => x.id !== id);
      res = { ok: true };
    });
    return res;
  },
  async setFeatured(id, val) {
    let res = { ok: false, code: 404 };
    await withData((d) => {
      const q = d.questions.find((x) => x.id === id);
      if (!q) { res = { ok: false, code: 404 }; return; }
      q.featured = !!val;
      res = { ok: true };
    });
    return res;
  },
  async replyCounts() {
    const d = await readRemote();
    const counts = {};
    for (const r of d.replies) {
      if (r.questionId) counts[r.questionId] = (counts[r.questionId] || 0) + 1;
    }
    return counts;
  },
  async createUser(u) {
    let existed = false;
    await withData((d) => {
      const existing = d.users.find((x) => x.id === u.id);
      if (existing) { existed = true; return; }
      d.users.push(u);
    });
    return { existed };
  },
  async getUserSalt(id) {
    const d = await readRemote();
    const a = d.users.find((x) => x.id === id);
    return a ? a.salt : null;
  },
  async verifyUser(id, pwdHash) {
    const d = await readRemote();
    const a = d.users.find((x) => x.id === id);
    return !!a && a.pwdHash === pwdHash;
  },
  async listMyQuestions(ownerId) {
    const d = await readRemote();
    return d.questions.filter((q) => q.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async listMyReplies(ownerId) {
    const d = await readRemote();
    return d.replies.filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async debug() {
    const info = {
      MODE, EXPLICIT_STORAGE, mode: MODE,
      cosConfigured: !!(COS_SECRET_ID && COS_SECRET_KEY && COS_BUCKET),
      cosBucket: COS_BUCKET, cosRegion: COS_REGION, cosKey: COS_KEY,
    };
    if (MODE === 'cos') {
      try {
        // 真实连通性：headBucket 探活（凭证/桶/地域不对会直接报错，不像 readRemote 静默兜底）
        await new Promise((resolve, reject) => {
          getCos().headBucket({ Bucket: COS_BUCKET, Region: COS_REGION }, (err, data) => {
            if (err) return reject(err);
            resolve(data);
          });
        });
        // 读写往返测试：证明确实可写、可读，再清理探针对象
        const probeKey = COS_KEY + '.probe-' + Date.now();
        await new Promise((resolve, reject) => {
          getCos().putObject({
            Bucket: COS_BUCKET, Region: COS_REGION, Key: probeKey,
            Body: '1', ContentType: 'text/plain',
          }, (e) => (e ? reject(e) : resolve()));
        });
        await new Promise((resolve, reject) => {
          getCos().getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: probeKey }, (e) => (e ? reject(e) : resolve()));
        });
        await new Promise((resolve) => {
          getCos().deleteObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: probeKey }, () => resolve());
        });
        const d = await readRemote();
        info.cos = {
          ok: true,
          questionCount: d.questions.length,
          replyCount: d.replies.length,
        };
      } catch (e) {
        info.cos = { ok: false, message: (e && e.message) || String(e) };
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
    return {
      MODE, EXPLICIT_STORAGE, mode: MODE,
      cosConfigured: !!(COS_SECRET_ID && COS_SECRET_KEY && COS_BUCKET),
      file: DATA_FILE,
    };
  },
};

// ---------- 导出 ----------
const store = MODE === 'cos' ? cosStore : fileStore;
store.mode = MODE;
store.init = MODE === 'cos' ? cosStore.init : fileStore.init;
module.exports = store;
