# ============================================================
# Stage 1: Install production dependencies
# ============================================================
FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# Install production deps only; allow postinstall scripts so
# Playwright can download browser binaries into node_modules
RUN npm ci --omit=dev

# ============================================================
# Stage 2: Build TypeScript
# ============================================================
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# Full install (devDeps needed for tsc); skip postinstall to
# avoid downloading browsers — we only need the compiled JS
RUN npm ci --ignore-scripts && npm run build

# ============================================================
# Stage 3: Runtime — Playwright official image with Chromium
# ============================================================
FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime

WORKDIR /app

# Tell Playwright where to find browsers shipped with this image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Defaults overridable via ConfigMap / env
ENV NODE_ENV=production \
    API_PORT=3000 \
    DATA_DIR=/app/data/tasks \
    LOG_DIR=/app/logs

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled JS from builder stage
COPY --from=builder /app/dist ./dist

# Copy package.json (needed by Node.js for module resolution)
COPY package.json ./

# Create bml user/group (601:601) and data/log directories
RUN groupadd -g 601 bml && \
    useradd -u 601 -g bml -m bml && \
    mkdir -p /app/data/tasks /app/logs && \
    chown -R bml:bml /app

USER bml

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})" || exit 1

# Default: start API server. K8s overrides via command/args.
CMD ["node", "dist/api/server.js"]
