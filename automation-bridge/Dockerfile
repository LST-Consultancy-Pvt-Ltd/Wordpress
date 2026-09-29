# Automation Bridge sidecar.
#   docker build -t automation-bridge .
#   docker build --build-arg WITH_DOCKER_CLI=1 -t automation-bridge:ops .   # deployment capability
#
# Runs as uid 10001, works with a read-only root filesystem (all writes go to
# /var/lib/automation-bridge and the mounted writable roots; mount /tmp as tmpfs).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
# git: repository facts and validation worktrees. docker CLI only on request:
# giving a container Docker API access is equivalent to root on the host, see README.
ARG WITH_DOCKER_CLI=0
RUN apk add --no-cache git tini \
 && if [ "$WITH_DOCKER_CLI" = "1" ]; then apk add --no-cache docker-cli docker-cli-compose; fi \
 && addgroup -g 10001 bridge && adduser -D -H -u 10001 -G bridge bridge \
 && mkdir -p /var/lib/automation-bridge /data/overrides /data/content /etc/automation-bridge \
 && chown -R 10001:10001 /var/lib/automation-bridge /data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json openapi.json ./
ENV NODE_ENV=production \
    BRIDGE_CONFIG=/etc/automation-bridge/automation-bridge.config.json \
    BRIDGE_PORT=8787
USER 10001:10001
EXPOSE 8787
VOLUME ["/var/lib/automation-bridge"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.BRIDGE_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/sidecar/main.js"]
