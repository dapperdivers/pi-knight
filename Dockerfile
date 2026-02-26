FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim
WORKDIR /app

# System packages — minimal set for agent operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install mise — declarative tool manager
# Tools are managed via mise.toml (baseline baked here, knight-specific via ConfigMap)
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

# Bake baseline tools into the image (rg, python, yq)
COPY mise.toml /app/mise.toml
ENV MISE_DATA_DIR=/app/.mise \
    MISE_CONFIG_FILE=/app/mise.toml \
    MISE_YES=1
RUN mise install --cd /app && mise reshim

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY defaults/ ./defaults/
COPY scripts/ ./scripts/

# Runtime mise config — points to /data for knight self-provisioning
# Baseline shims from /app/.mise, knight-specific from /data/.mise
ENV NODE_ENV=production \
    MISE_DATA_DIR=/data/.mise \
    MISE_YES=1 \
    NMAP_DATADIR=/data/share/nmap \
    PERL5LIB=/data/share/perl5 \
    PATH="/data/bin:/data/.mise/shims:/app/.mise/shims:${PATH}" \
    LD_LIBRARY_PATH="/data/lib:${LD_LIBRARY_PATH}"

# Non-root (node:22-slim already has 'node' user at uid 1000)
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
