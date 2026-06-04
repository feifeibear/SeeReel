ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build

WORKDIR /app
ENV REELYAI_SKIP_SKILL_INSTALL=1

COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com \
  && npm config set replace-registry-host always
RUN npm ci

COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=5173 \
    REELYAI_COOKIE_SECURE=1 \
    REELYAI_SKIP_SKILL_INSTALL=1

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/AGENTS.md ./AGENTS.md
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/README.zh-CN.md ./README.zh-CN.md

RUN mkdir -p /app/data/media && chown -R node:node /app

USER node
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5173/api/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
