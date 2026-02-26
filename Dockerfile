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
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Nix (single-user, no daemon) ─────────────────────────────────
# Nix is the primary tool manager for knights. Each knight declares
# its tools via a flake.nix in its ConfigMap.
#
# Key: chown /nix to uid 1000 (node user) so init containers running
# as non-root can use nix build without permission errors.
RUN mkdir -m 0755 /nix \
    && mkdir -p /etc/nix \
    && echo "build-users-group =" > /etc/nix/nix.conf \
    && echo "experimental-features = nix-command flakes" >> /etc/nix/nix.conf \
    && curl -L https://nixos.org/nix/install | sh -s -- --no-daemon \
    && chown -R 1000:1000 /nix
ENV NIX_CONFIG="experimental-features = nix-command flakes"

# ── Mise (baseline tools: rg, python, yq) ────────────────────────
# Mise runs AFTER Nix in the tool hierarchy. Provides lightweight
# baseline tools that all knights share regardless of their flake.
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh
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

# Runtime config
# Tool priority (left to right = highest to lowest):
#   1. /data/nix-env/bin — Nix flake tools (knight-specific)
#   2. /data/bin — legacy persistent binaries (fallback)
#   3. /data/.mise/shims — mise knight-specific tools
#   4. /app/.mise/shims — mise baseline tools (rg, python, yq)
ENV NODE_ENV=production \
    MISE_DATA_DIR=/data/.mise \
    MISE_YES=1 \
    PATH="/data/nix-env/bin:/data/bin:/data/.mise/shims:/app/.mise/shims:${PATH}"

# Non-root (node:22-slim already has 'node' user at uid 1000)
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
