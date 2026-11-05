# 冰箱管家服务端 —— Cloud Run 镜像
#
# 为什么自己带 Dockerfile 而不用 buildpacks：
# Node 版本、依赖安装方式、启动命令全都写死在这里，
# 以后平台换构建器也不会悄悄改用别的 Node 版本跑。

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# 先只拷依赖清单：package 没变时这一层直接命中缓存，
# 改代码不会重新装一遍依赖。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 运行期只需要这三个（test/ tools/ 是开发用的，不进镜像）
COPY lib ./lib
COPY public ./public
COPY server.js ./

# Cloud Run 会把 PORT 注入成 8080；代码里是 process.env.PORT || 8080
EXPOSE 8080

CMD ["node", "server.js"]
