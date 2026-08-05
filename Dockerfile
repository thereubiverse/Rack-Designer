# Multi-stage build for the Next server.
#
# The install and the build BOTH happen in this image, on Linux. That is not a stylistic choice:
# @napi-rs/canvas ships a platform-specific native binary (the dev machine has
# canvas-darwin-arm64), and it is what rasterises a PDF page for symbol discovery. Copying a Mac's
# node_modules into a Linux container fails at runtime with "Cannot find native binding", which the
# app surfaces as a generic "couldn't search this plan". Installing here resolves the right
# optional dependency for the platform.

FROM node:22-slim AS deps
WORKDIR /app
# Only the manifests, so this layer is cached until dependencies actually change.
COPY package.json package-lock.json ./
# `npm ci` honours the lockfile exactly and picks the linux-x64 optional dependencies.
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No Supabase credentials are available or needed at build time: every page that touches the
# database is `force-dynamic`, so nothing is prerendered and createServiceClient is never called.
# If that ever stops being true, the build fails here rather than shipping a page baked at build.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Run as a non-root user. The base image already provides `node` (uid 1000).
USER node

# `output: "standalone"` produces a self-contained server plus only the traced dependencies.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Render supplies PORT; default for a plain `docker run`.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
