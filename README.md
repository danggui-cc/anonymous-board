# 欲言信箱（匿名提问箱）

把飞书多维表格共享页复制、优化成一个**普通网页**：线上课程里学员不好意思公开问的问题，
都可以在这里匿名投递；所有人可浏览，并对感兴趣的问题留言回复。

> 标语：**你所有未说出口的话，都值得被听见。**

## 特性
- 📮 **完全匿名**：不登录、不记录姓名 / 账号 / IP，提问者与回复者统一显示为「匿名用户」
- 🗂️ **分类**：内核探寻 / 审美与灵感 / 创作流与技艺 / 定价与价值感 / 沟通与边界 / 运营与系统 / 能量与身心养护 / 其他
- 🔍 **搜索**：关键词关联到相关问题（匹配标题或内容）
- 🃏 **双列卡片**：首页以卡片双列铺陈，一个问题一张卡片，点开进入评论区式详情页
- 💬 **内嵌回复区**：详情页类小红书 / 微博评论区，可发回复、可删自己的回复
- 🕒🔥 **排序**：首页「全部问题」右侧可切换「时间 / 热度」（热度 = 回复数）排序
- 🗑️ **可删自己的发言**：提问 / 回复均凭私密令牌删除（同浏览器自动识别；问题和回复都支持**跨设备管理链接**）
- 🛡️ **管理员清理**：输入口令进入「管理模式」后，可删除任意违规问题 / 回复（口令由环境变量 `ADMIN_KEY` 控制）
- 💾 **零依赖**：纯 Node.js 内置模块，数据存 `data/data.json`
- 🎨 淡墨绿调视觉

## 本地运行
```bash
node server.js        # 或 npm start
# 打开 http://localhost:3000
PORT=8080 node server.js   # 自定义端口

# 管理员口令（可选，本地默认 change-me-admin）
ADMIN_KEY=你的强口令 node server.js
```

## 部署到公网（Render，免费，支持真正的多人共享）
仓库已自带 `render.yaml` 蓝图，一键部署：
1. 把 `anonymous-board` 目录推到 GitHub
2. Render 控制台 → New → **Blueprint** → 连接该仓库
3. 创建时按提示为 `ADMIN_KEY` 设置一个强口令（用于清理违规内容）
4. 部署完成后获得 `https://yuyan-mailbox.onrender.com` 公开链接，直接分享即可

> 也可手动新建 Web Service：Build Command 留空，Start Command `node server.js`，并设置环境变量 `ADMIN_KEY`。
> CloudStudio 等静态托管只提供静态文件、不带后端，页面会以「本地模式」运行（数据仅存于打开者各自的浏览器）。
> 需要真正的多人共享，请部署到带 Node 运行时的平台（Render / Railway / 自己的服务器）。

## 接口
- `GET  /api/questions?category=&q=&sort=`     列表（可按类别 / 关键词 / 排序筛选，`sort=time|heat`）
- `POST /api/questions`                          提问，body `{title?, content, category}`，返回 `{id, deleteToken}`
- `GET  /api/questions/:id`                      问题详情 + 回复列表
- `DELETE /api/questions/:id`                    删问题（body `{token}`，连带删除其回复）
- `POST /api/questions/:id/replies`              回复，body `{content}`，返回 `{id, deleteToken}`
- `DELETE /api/replies/:id`                      删回复（body `{token}`）
- `POST /api/admin/verify`                       校验管理员口令，body `{key}`
- `DELETE /api/admin/questions/:id`              管理员删问题（header `x-admin-key`）
- `DELETE /api/admin/replies/:id`                管理员删回复（header `x-admin-key`）

## 跨设备管理链接
- 提问 / 回复的删除令牌由系统生成，**访问对应管理链接即在任意设备获得删除权限**（不再弹窗提醒，静默生效）：
  - 问题：`question.html?id=ID&manage=ID.TOKEN`
  - 回复：`question.html?id=ID&manageReply=RID.TOKEN`
- 同浏览器内会**自动识别**你的令牌并显示「删除」按钮，无需手动保存链接。

---

# 给新手：从零把项目提交到 Git（一步一步）

> 下面的命令在你**自己的电脑**终端里运行（不是在本项目运行环境）。先在终端输入 `git --version`：
> - 显示版本号 → 已安装，直接跳到第 1 步。
> - 提示 "command not found" → 先装 Git：
>   - Windows / macOS：到 https://git-scm.com 下载，一路下一步装完，**重开终端**。
>   - Linux / 鸿蒙（类 Linux）：用系统包管理器，例如 `sudo apt install git`（或对应应用商店搜索 Git）。
>   装完再执行下面的步骤。

**第 1 步：进入项目目录**
```bash
cd 路径/到/anonymous-board
```
把"路径/到"换成你实际存放文件夹的位置。也可以在文件管理器里进入 `anonymous-board` 文件夹，右键「在终端中打开」。

**第 2 步：初始化仓库（只需做一次）**
```bash
git init
```
看到 `Initialized empty Git repository` 即成功。它会在文件夹里建一个隐藏的 `.git` 目录，用来记录所有历史版本。

**第 3 步：把源码加入暂存区**
```bash
git add .
```
`.` 表示当前目录全部文件。因为配好了 `.gitignore`，`data/`（用户数据）、`server.log`、`node_modules/`、`.workbuddy/` 等不会被加进来——仓库只放源码，这是正确的。

**第 4 步：提交第一个版本**
```bash
git commit -m "init: 欲言信箱匿名提问箱"
```
`-m` 后面是这次提交的说明，写什么都行，但建议有意义，方便以后回看。

**第 5 步：推送到 GitHub（让部署平台能拉到代码）**
1. 打开 https://github.com ，注册 / 登录。
2. 点右上角 **+** → **New repository**，仓库名填 `anonymous-board`，**不要**勾选 "Add a README / .gitignore"（我们已经有了），点 Create。
3. 创建后页面会显示仓库地址，复制形如 `https://github.com/你的用户名/anonymous-board.git` 的那行。
4. 回到终端，把本地仓库关联到 GitHub 并推送：
```bash
git remote add origin https://github.com/你的用户名/anonymous-board.git
git branch -M main
git push -u origin main
```
> 第一次推送会要求输入账号和密码：
> - 用户名 = 你的 GitHub 账号。
> - 密码处**不能填账号密码**（GitHub 已停用密码推送），要填 **Personal Access Token（PAT）**。
>   PAT 在 GitHub → 右上角头像 → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾选 `repo` 权限，生成后**复制保存**（只显示一次）。

**以后改了代码怎么提交？** 固定三步走：
```bash
git add .
git commit -m "这里写改了什么"
git push
```

---

# 部署（三种路线，按需求选）

### 路线 A：Render（最快，先跑通网页版，免费）
1. 确保代码已推到 GitHub（上一步）。
2. 打开 https://render.com 注册（可用 GitHub 登录）。
3. 控制台 → **New** → **Blueprint**（仓库里自带 `render.yaml`）→ 连接 GitHub 上的 `anonymous-board` 仓库。
4. 按提示为环境变量 `ADMIN_KEY` 设置一个**强口令**（用于清理违规内容，覆盖代码里默认的 `change-me-admin`）。
5. 点 Apply / Create，等 1–2 分钟，得到形如 `https://yuyan-mailbox.onrender.com` 的公开地址，直接分享即可。

> 手动方式（不用 Blueprint）：New → Web Service → 连仓库 → Runtime 选 `Node` → **Build Command 留空**（零依赖不用装）→ Start Command 填 `node server.js` → 加环境变量 `ADMIN_KEY` → Create。

⚠️ **Render 现在免费档也要绑外币卡验证**：如果你看到 "Add Card" 弹窗、没有 Visa/Mastercard，就走不通。请改用下面的 **路线 A-替代** 或 **路线 B/C**。

⚠️ **数据持久化坑**：Render 免费版磁盘是临时的，休眠 / 重启后 `data/data.json` 会被清空。两个办法：
- 在 Render 给服务挂一个 **Persistent Disk**（如挂载到 `/data`），并把环境变量 `DATA_DIR` 设为 `/data`——`server.js` 第 22 行已支持读 `DATA_DIR`。
- 或改用数据库（如 Render 自带的 PostgreSQL）。
> 端口不用管：平台会用 `PORT` 环境变量注入，代码第 20 行 `process.env.PORT || 3000` 已处理。

### 路线 A-替代：腾讯云 CloudBase / 华为云 / 阿里云容器服务（无外币卡）
如果你没外币信用卡，用**国内云容器服务**最现实：已实名认证、给 HTTPS 域名、网络在国内、可挂载持久卷。

这里以 **腾讯云 CloudBase 云托管** 为例（步骤最简单）：
1. 打开 https://console.cloud.tencent.com/tcb → 用微信/QQ 登录 → 完成实名认证。
2. 创建环境（选**按量计费**，有免费额度）。
3. 进入「云托管」→ 新建服务 → 选择**自定义部署**（从 GitHub 仓库或本地代码包）。
4. 来源选 GitHub，授权后选 `danggui-cc/anonymous-board` 仓库、分支 `main`。
5. 构建方式选 **使用 Dockerfile**（仓库根目录已有 `Dockerfile`）。
6. 服务配置：
   - 端口：`3000`
   - 环境变量：加 `ADMIN_KEY`（强口令）
   - 高级设置 → 挂载**持久卷**到 `/data`（让 `data.json` 不丢；CloudBase 会按量计费，费用很低）
7. 点「开始部署」，几分钟后得到 `https://xxx-xxx.gz.apigw.tencentcs.com` 之类的 HTTPS 地址。

华为云、阿里云步骤类似：找「容器服务 / 函数计算 FC / 云托管」，上传代码或连 GitHub，启动命令 `node server.js`，端口 `3000`，挂载持久存储到 `/data`。

### 路线 A-快速演示：Glitch（零门槛、不要卡、会休眠）
如果你只想先拿到一个公网链接做演示，可以用 Glitch：
1. 打开 https://glitch.com → 登录。
2. 新建项目 → Import from GitHub → 填 `danggui-cc/anonymous-board`。
3. Glitch 会自动读 `package.json` 并运行 `npm start`（即 `node server.js`）。
4. 点 Share → Live Site，得到公开链接。

⚠️ 缺点：免费实例 5 分钟没人访问会休眠，首次打开要等 5–10 秒唤醒；且磁盘可能随项目重启重置，**不适合正式长期使用**。

### 路线 B：国内云服务器 + 备案（要做微信小程序必须走这条）
- 买一台**大陆地域**的云服务器（腾讯云 / 阿里云 ECS，约几十元/月）+ 一个已 **ICP 备案** 的域名（备案约 1–2 周）。
- 服务器上用 `pm2` 守护进程运行 `node server.js`（断线 / 崩溃自动重启）。
- 用 `nginx` 反代 + 免费 HTTPS 证书（Let's Encrypt / 云厂商免费证书），把域名指向服务。
- 通过环境变量 / `.env` 配置 `ADMIN_KEY`、`DATA_DIR`。
- 在小程序后台把该 HTTPS 域名加入 **request 合法域名**，即可连通。

### 路线 C：微信云开发 CloudBase（小程序最省事）
- 自带 HTTPS 合法域名和数据库，不用自己管服务器。
- 需把 `server.js` 的接口逻辑改写成**云函数**（或云托管容器），数据库改用云数据库。
- 适合「不想运维、目标就是小程序」的场景。本项目 `wechat-mp/` 目录是小程序前端雏形，仍在进行中（尚未完成）。
