# ─────────────────────────────────────────────
# Stage 1: Build the frontend (Vite)
# ─────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
# Install ALL deps (including devDeps) for build step
RUN npm ci

# Copy source and build frontend
COPY . .
# Vite requires VITE_ prefixed env vars to be available during build
ARG VITE_GEMINI_API_KEY
ENV VITE_GEMINI_API_KEY=$VITE_GEMINI_API_KEY
RUN npm run build

# ─────────────────────────────────────────────
# Stage 2: Production image
# ─────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Copy package files and install PRODUCTION deps + tsx (needed to run server.ts)
COPY package*.json ./
RUN npm ci --omit=dev && npm install tsx

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy server source
COPY server.ts ./
COPY tsconfig.json ./

# Cloud Run injects PORT automatically; default to 3000 for local testing
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# Use tsx to execute TypeScript server directly
CMD ["node_modules/.bin/tsx", "server.ts"]
