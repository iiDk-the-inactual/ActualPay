# syntax=docker/dockerfile:1.7
#
# One image, several commands (api, worker, signer, db, admin-create). The
# signer should run on its OWN host from this same image; see docs/deployment.md.
#
# Pin the base image by digest for reproducible builds:
#   docker buildx imagetools inspect node:22-bookworm-slim
# and replace the tag below with node:22-bookworm-slim@sha256:<digest>.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: install everything, bundle to plain JavaScript ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --ignore-scripts
COPY scripts ./scripts
RUN npm run build
# Collect only the package manifests: the runtime stage needs them for `npm ci`.
RUN mkdir /manifests \
 && find . -name package.json -not -path '*/node_modules/*' -not -path './dist/*' \
      -exec sh -c 'for f; do mkdir -p "/manifests/$(dirname "$f")" && cp "$f" "/manifests/$f"; done' _ {} + \
 && cp package-lock.json /manifests/

# ---- runtime: production dependencies only, no TypeScript, no dev tools ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=build /manifests ./
# --ignore-scripts: no dependency may run code at install time. The native
# argon2 addon ships prebuilt binaries for glibc, which this base image uses.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && rm -rf /root/.npm
COPY --from=build /app/dist ./dist
# Unprivileged user (uid 1000, built into the base image); nothing is written to the image filesystem.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Default command is the API; override for the other processes.
CMD ["node", "dist/api.mjs"]
