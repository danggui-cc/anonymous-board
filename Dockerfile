# 欲言信箱 —— 匿名提问箱容器镜像
#
# 部署到腾讯云 CloudBase 云托管时：
#   - 在控制台环境变量设置 MONGODB_URI（腾讯云 MongoDB 内网连接串）
#     即自动走 mongo 模式，数据存于云端，所有浏览器/设备共享、重部署不丢
#   - 未设置 MONGODB_URI 时回退到本地文件模式（仅本机可见，重部署会丢）

FROM node:18-slim

WORKDIR /app

# 安装依赖（mongodb 官方驱动，纯 JS 实现，无需 native 编译）
COPY package.json ./
RUN npm install --production

# 复制应用代码
COPY server.js storage.js ./
COPY public ./public

ENV PORT=3000
ENV NODE_ENV=production
# 默认本地文件兜底；若容器环境变量设置了 MONGODB_URI，storage.js 会自动切到 mongo 模式。

# 创建数据目录并允许写入（部分云环境要求，文件模式用）
RUN mkdir -p /data && chmod 777 /data

EXPOSE 3000

CMD ["node", "server.js"]
