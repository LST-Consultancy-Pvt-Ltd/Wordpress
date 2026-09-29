# Sample site image. Build context: the automation-bridge/ directory
# (docker-compose.yml sets it), because the site depends on the local package.
FROM node:22-alpine AS bridge
WORKDIR /src/automation-bridge
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY openapi.json automation-bridge.config.example.json ./
RUN npm run build

FROM node:22-alpine AS build
WORKDIR /src/automation-bridge
COPY --from=bridge /src/automation-bridge/package.json /src/automation-bridge/openapi.json /src/automation-bridge/automation-bridge.config.example.json ./
COPY --from=bridge /src/automation-bridge/dist ./dist
WORKDIR /src/automation-bridge/examples/sample-site
COPY examples/sample-site/package.json examples/sample-site/package-lock.json examples/sample-site/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY examples/sample-site/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:22-alpine AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    CONTENT_DIR=/data/content/posts AUTOMATION_OVERRIDES_DIR=/data/overrides
# /data/* is owned by the bridge uid (10001) so the sidecar can write through the
# shared volumes; the site (uid 1001) only reads them.
RUN addgroup -g 1001 site && adduser -D -H -u 1001 -G site site \
 && mkdir -p /data/content /data/overrides && chown 10001:10001 /data/content /data/overrides
WORKDIR /app
COPY --from=build --chown=1001:1001 /src/automation-bridge/examples/sample-site/.next/standalone ./
COPY --from=build --chown=1001:1001 /src/automation-bridge/examples/sample-site/.next/static ./.next/static
COPY --from=build /src/automation-bridge/examples/sample-site/public ./public
COPY --from=build --chown=10001:10001 /src/automation-bridge/examples/sample-site/content /data/content
USER 1001:1001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
