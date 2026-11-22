# syntax=docker/dockerfile:1.7
# Coinnibal: one container = game server + static web client on the same origin.
#   docker build -t coinnibal --build-arg VITE_PUBLIC_URL=https://your-domain \
#     --build-arg VITE_CHAIN_ID=46630 --build-arg VITE_ARENA_ADDRESS=0x... --build-arg VITE_NFT_ADDRESS=0x... .
#   docker run -p 8787:8787 -v coinnibal-data:/data --env-file apps/server/.env coinnibal
# Solidity is not compiled here: packages/contracts/src/artifacts.ts (ABIs + bytecode) is committed.

FROM node:22-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CI=1
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
# git: the contracts' forge-std test library is a git dependency (fetched over HTTPS, no SSH key needed)
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && git config --global url."https://github.com/".insteadOf "git@github.com:" \
 && git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"

# install dependencies first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY packages/art/package.json packages/art/
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps ./apps

# Build-time settings for the browser bundle. VITE_PUBLIC_URL is the site's public origin (no trailing
# slash): index.html uses it for the absolute canonical and Open Graph URLs. Set it to the same value as
# the server's PUBLIC_URL; change both (and the DNS) to move the site to another domain.
# The site trusts the contracts the owner wallet signed for in /admin (apps/web/src/wallet/pinned.ts; VITE_OWNER_WALLET
# overrides the built-in owner, on the VPS from COINNIBAL_OWNER_WALLET). VITE_CHAIN_ID (the server's CHAIN_ID) and
# VITE_ARENA_ADDRESS, VITE_NFT_ADDRESS, VITE_TOKEN_ADDRESS are an optional override of those pins (on the VPS from
# COINNIBAL_PIN_* in .env).
ARG VITE_SERVER_URL=""
ARG VITE_RPC_URL=""
ARG VITE_PUBLIC_URL=""
ARG VITE_CHAIN_ID=""
ARG VITE_ARENA_ADDRESS=""
ARG VITE_NFT_ADDRESS=""
ARG VITE_TOKEN_ADDRESS=""
ARG VITE_OWNER_WALLET=""
ENV VITE_SERVER_URL=$VITE_SERVER_URL VITE_RPC_URL=$VITE_RPC_URL VITE_PUBLIC_URL=$VITE_PUBLIC_URL \
    VITE_CHAIN_ID=$VITE_CHAIN_ID VITE_ARENA_ADDRESS=$VITE_ARENA_ADDRESS VITE_NFT_ADDRESS=$VITE_NFT_ADDRESS \
    VITE_TOKEN_ADDRESS=$VITE_TOKEN_ADDRESS VITE_OWNER_WALLET=$VITE_OWNER_WALLET

RUN pnpm -F @coinnibal/web build \
 && pnpm -F @coinnibal/server build \
 && pnpm --filter @coinnibal/server deploy --legacy --prod /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    TRUST_PROXY=1
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./web
# the VPS installer, served to admins for the move to a new server (GET /api/admin/install.sh: the repository is private)
COPY deploy/vps/install.sh ./deploy/vps/install.sh
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health?live=1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
