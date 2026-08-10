# 欲言信箱 —— 匿名提问箱容器镜像
# 用法示例（本地）：
#   docker build -t yuyan-mailbox .
#   docker run -p 3000:3000 -e ADMIN_KEY=你的强口令 -v yuyan-data:/data yuyan-mailbox
#
# 部署到腾讯云 CloudBase 云托管时：
#   - 自动检测云环境并改用自带云数据库（STORAGE=tcb），数据持久、重启不丢
#   - 也可在控制台环境变量显式设置 STORAGE=tcb 强制云数据库模式

FROM node:18-slim

WORKDIR /app

# 先装依赖（@cloudbase/node-sdk 用于云数据库模式；本地文件模式不会加载它）
COPY package.json ./
RUN npm install --production

# 复制应用代码
COPY server.js storage.js ./
COPY public ./public

# 数据目录：本地文件模式（STORAGE=file）会把数据写到这里
ENV PORT=3000
ENV DATA_DIR=/data
ENV NODE_ENV=production

# 创建数据目录并允许写入（部分云环境要求）
RUN mkdir -p /data && chmod 777 /data

EXPOSE 3000

CMD ["node", "server.js"]
