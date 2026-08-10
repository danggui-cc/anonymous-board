# 欲言信箱 —— 匿名提问箱容器镜像（纯 Node.js，零依赖）
# 用法示例（本地）：
#   docker build -t yuyan-mailbox .
#   docker run -p 3000:3000 -e ADMIN_KEY=你的强口令 -v yuyan-data:/data yuyan-mailbox

FROM node:18-alpine

WORKDIR /app

# 仅复制必要文件，避免把 data/、本地日志等打进镜像
COPY package.json server.js ./
COPY public ./public

# 数据目录：云平台上可挂载持久卷到这里
ENV PORT=3000
ENV DATA_DIR=/data
ENV NODE_ENV=production

# 创建数据目录并允许非 root 写入（部分云环境要求）
RUN mkdir -p /data && chmod 777 /data

EXPOSE 3000

CMD ["node", "server.js"]
