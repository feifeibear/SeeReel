FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV REELYAI_SKIP_SKILL_INSTALL=1

COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com \
  && npm config set replace-registry-host always
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

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

CMD ["npm", "run", "start"]
