# Build the dashboard, then run the engine as a non-root user.
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY src/api-types.ts ../src/api-types.ts
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries for this image; fall back to building if needed
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY --from=web /app/web/dist ./web/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
# Inside the container the app must listen on all interfaces; compose publishes it on 127.0.0.1 only.
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/tradeai.db KEYSTORE_PATH=/app/data/burner.keystore.json
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]
