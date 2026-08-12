# 腾讯云 SCF 云函数部署「欲言信箱」（免费替代 CloudBase）

> 适用场景：CloudBase 环境被隔离、不想付费。SCF 云函数有**免费额度**（每月 100 万次调用、40 万 GBs 资源用量），对一年后才用的低频信箱绰绰有余，且**国内直连快**。
> 数据仍在你已经建好的腾讯云 COS 桶（`yuyan-1341046552`）里，不用重发历史内容。

---

## 前置（你已完成）
- ✅ 腾讯云账号已实名
- ✅ 已建好 COS 桶 `yuyan-1341046552`（地域 ap-guangzhou）
- ✅ 已有腾讯云 API 密钥 SecretId / SecretKey（访问管理 → API 密钥管理）

---

## 第一步：拿到代码
1. 打开 GitHub 仓库：`https://github.com/danggui-cc/anonymous-board`
2. 点绿色 **「Code」→「Download ZIP」**，下载到本机。
3. 解压，得到文件夹 `anonymous-board-main/`（里面直接是 `server.js`、`storage.js`、`public/` 等）。

> 这一步只是把代码下载下来，后面要整个上传到 SCF。

---

## 第二步：新建 SCF Web 函数
1. 打开 [腾讯云 SCF 控制台](https://console.cloud.tencent.com/scf) → 左侧 **「函数服务」**。
2. 点 **「新建」**，创建方式选 **「从头开始」**。
3. 关键配置：
   - **函数类型**：选 **「Web 函数」**（直接处理 HTTP 请求，Express 原生支持）
   - **函数名称**：`yuyan`（随意）
   - **地域**：**广州**（必须和 COS 桶 ap-guangzhou 同地域，否则内网连不上）
   - **运行环境**：选 **Node.js 18**
4. **提交方法**：
   - 优先选 **「本地上传文件夹」**，直接选刚才解压的 `anonymous-board-main` 文件夹；
   - 如果浏览器不支持文件夹上传，就进 `anonymous-board-main` 文件夹，**全选里面所有文件**重新压缩成 zip，再选 **「本地上传 zip 包」**。（注意：zip 里 `server.js` 必须在根目录，不要多套一层文件夹。）
5. 点 **「完成」**。

> 代码里已经有 `scf_bootstrap` 启动文件，但我们更推荐下一步在控制台显式配置启动命令（更稳，不受文件权限影响）。

---

## 第三步：开启在线依赖安装（最重要，免你手动装）
SCF 上传后会**按 package.json 自动 `npm install`**，把 `cos-nodejs-sdk-v5` 装好，你不用自己敲命令。
1. 在函数详情 → **「函数代码」** 标签页。
2. 右上角点开设置/「···」，找到 **「自动依赖安装」** 并**开启**。
3. （如果没有这个选项，就用在线 IDE 顶部「终端」执行 `npm install cos-nodejs-sdk-v5` 再点部署。）

---

## 第四步：配置启动命令
1. 仍在 **「函数代码」** 标签页，找到 **「高级设置」→「启动命令」**。
2. 填入（整行复制）：
   ```
   export PORT=9000 && node server.js
   ```
3. 保存。

> 这会让服务监听 SCF 约定的 9000 端口。代码无需改动，`server.js` 已经支持。

---

## 第五步：配置环境变量（连回 COS）
1. 函数详情 → **「函数配置」**（或「环境变量」）标签页 → **「编辑」**。
2. 新增 4 条：

   | 变量名 | 值 |
   |---|---|
   | `COS_SECRET_ID` | 你的 SecretId（`AKID...`） |
   | `COS_SECRET_KEY` | 你的 SecretKey（一长串） |
   | `COS_BUCKET` | `yuyan-1341046552` |
   | `COS_REGION` | `ap-guangzhou` |

3. 保存。

> ⚠️ `COS_SECRET_KEY` 等同账号密码，**不要截图发我**，只在控制台填。

---

## 第六步：部署并拿到公网地址
1. 回到 **「函数代码」** 标签页，点 **「部署」**（让上面的改动生效）。
2. 部署完成后，函数详情 → **「触发器管理」**（或「访问路径」），会显示一条 **API 网关地址**，形如：
   `https://service-xxxx.gz.apigw.tencentcs.com/release/`
   这就是新的公网网址，复制保存。

> 该默认域名未备案，手机/电脑访问时浏览器可能提示「网页有风险」——点「继续访问」即可，不影响功能（和之前 CloudBase 共享域名一样）。

---

## 第七步：验证连通
浏览器打开：
```
https://你的网关地址/api/debug
```
应看到：
```json
{
  "mode": "cos",
  "cosConfigured": true,
  "cos": { "ok": true, "questionCount": 0, "replyCount": 0 }
}
```
- `mode:"cos"` + `cos.ok:true` → 成功，手机/电脑/不同浏览器发的内容**持久共享**。
- 若 `mode:"file"` 或 `cos.ok:false`，把返回的 `message` 发我。

**互测**：手机发一条 → 电脑打开同一地址应立刻看到；再重新部署一次，内容仍在（证明持久化）。

---

## 收尾提醒
1. **免费额度**：每月 100 万次调用免费，低频信箱几乎零成本；只有真用很多才可能产生几毛钱外网流量费。
2. **密钥安全**：SecretKey 只在 SCF 变量里，别外传。
3. **撤销 GitHub 令牌**（部署稳定后）：GitHub → 头像 → Settings → Developer settings → Personal access tokens → Tokens (classic)，找到给 anonymous-board 仓库用的那个 classic 令牌（备注/名称里带"推送"用途的），点 **Revoke / 删除**。（该令牌已不适合继续使用，撤销后若还需改代码，我会生成新的。）
