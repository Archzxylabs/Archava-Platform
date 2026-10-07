FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY config ./config
COPY scripts ./scripts
COPY server ./server
COPY public ./public
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libopus0 ffmpeg libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=web /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY --from=web /app/node_modules ./node_modules
COPY --from=web /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY config ./config
COPY prompts ./prompts
COPY backend ./backend
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && useradd --create-home archava && chown -R archava:archava /app
USER archava
ENV PORT=5002 RUN_MODE=all PYTHONUNBUFFERED=1
EXPOSE 5002
CMD ["./entrypoint.sh"]
