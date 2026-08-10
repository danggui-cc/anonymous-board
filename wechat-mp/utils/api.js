// 欲言信箱 —— 小程序网络层（封装 wx.request，对齐 server.js 接口）
const config = require('./config');

function request(method, path, data, headers) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.API_BASE + path,
      method,
      data: data || {},
      header: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else reject(new Error((res.data && res.data.error) || ('请求失败(' + res.statusCode + ')')));
      },
      fail(err) {
        reject(new Error(err.errMsg === 'request:fail' ? '网络错误，请检查后端域名配置' : (err.errMsg || '网络错误')));
      },
    });
  });
}

const api = {
  // GET /api/questions?category=&q=&sort=
  list({ category, q, sort }) {
    const params = [];
    if (category && category !== '全部') params.push('category=' + encodeURIComponent(category));
    if (q) params.push('q=' + encodeURIComponent(q));
    params.push('sort=' + (sort || 'time'));
    return request('GET', '/api/questions?' + params.join('&'));
  },
  // POST /api/questions
  createQuestion({ title, content, category, author }) {
    return request('POST', '/api/questions', { title, content, category, author });
  },
  // GET /api/questions/:id
  getQuestion(id) {
    return request('GET', '/api/questions/' + encodeURIComponent(id));
  },
  // POST /api/questions/:id/replies
  createReply(id, content, quoteId, author) {
    const body = { content, author };
    if (quoteId) body.quoteId = quoteId;
    return request('POST', '/api/questions/' + encodeURIComponent(id) + '/replies', body);
  },
  // DELETE /api/questions/:id
  deleteQuestion(id, token) {
    return request('DELETE', '/api/questions/' + encodeURIComponent(id), { token });
  },
  // DELETE /api/replies/:id
  deleteReply(id, token) {
    return request('DELETE', '/api/replies/' + encodeURIComponent(id), { token });
  },
  // POST /api/admin/verify
  adminVerify(key) {
    return request('POST', '/api/admin/verify', { key });
  },
  // DELETE /api/admin/questions/:id （header x-admin-key）
  adminDeleteQuestion(id, key) {
    return request('DELETE', '/api/admin/questions/' + encodeURIComponent(id), {}, { 'x-admin-key': key });
  },
  // DELETE /api/admin/replies/:id
  adminDeleteReply(id, key) {
    return request('DELETE', '/api/admin/replies/' + encodeURIComponent(id), {}, { 'x-admin-key': key });
  },
};

module.exports = api;
