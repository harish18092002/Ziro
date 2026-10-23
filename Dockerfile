# syntax=docker/dockerfile:1
#
# Ziro: one image that serves the API and the built console on one port.
#
#   build   every dependency, then `npm run build` (libraries, API, web)
#   deps    production dependencies only: --omit=dev, and --omit=optional so the Agent SDK's ~285 MB native
#           binary (harness B, an eval-time tool) is not shipped. Harness A, the loop, is what runs here.
#   runtime the compiled output and those dependencies, as the unprivileged `node` user
#
# The same image runs the service and the deploy job (apps/api/dist/scripts/prepare.js).
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Manifests first, so a source change does not reinstall.
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/datagen/package.json packages/datagen/
COPY packages/evals/package.json packages/evals/
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN npm run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/datagen/package.json packages/datagen/
COPY packages/evals/package.json packages/evals/
RUN npm ci --omit=dev --omit=optional --workspace @ziro/api --include-workspace-root=false \
 && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY package.json ./
# The workspace packages are symlinked from node_modules, so they sit where npm put them: package.json + dist.
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/datagen/package.json packages/datagen/package.json
COPY --from=build /app/packages/datagen/dist packages/datagen/dist
COPY --from=build /app/packages/evals/package.json packages/evals/package.json
COPY --from=build /app/packages/evals/dist packages/evals/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist

# Read-only for the app: the user that runs it owns nothing it could overwrite. /tmp is where the demo's
# generated data goes (in memory on Cloud Run).
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]
