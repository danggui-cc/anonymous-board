# 欲言信箱 —— 匿名提问箱容器镜像
# 用法示例（本地）：
#   docker build -t yuyan-mailbox .
#   docker run -p 3000:3000 -e ADMIN_KEY=你的强口令 -v yuyan-data:/data yuyan-mailbox
#
# 部署到腾讯云 CloudBase 云托管时：
#   - 在控制台环境变量设置 MONGODB_URI（MongoDB Atlas 连接串）即自动走 mongo 模式
#   - 数据存于 MongoDB Atlas 免费集群，跨设备/跨浏览器共享、重启不丢
#   - 未设置 MONGODB_URI 时回退到本地文件模式（STORAGE=file）

FROM node:18-slim

WORKDIR /app

# 先装依赖（mongodb 驱动用于云数据库模式；本地文件模式不会加载它）
COPY package.json ./
RUN npm install --production

# 复制应用代码
COPY server.js storage.js ./
COPY public ./public

ENV PORT=3000
ENV NODE_ENV=production
# 默认本地文件兜底；若容器环境变量设置了 MONGODB_URI，storage.js 会自动切到 mongo 模式

# 创建数据目录并允许写入（部分云环境要求，文件模式用）
RUN mkdir -p /data && chmod 777 /data

EXPOSE 3000

CMD ["node", "server.js"]
