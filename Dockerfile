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

# Install Nix (single-user, no daemon) — declarative tool management for knights
# Pre-create /nix so the installer doesn't need sudo
RUN mkdir -m 0755 /nix && chown root /nix \
    && curl -L https://nixos.org/nix/install | sh -s -- --no-daemon
ENV NIX_PROFILE_SCRIPT="/root/.nix-profile/etc/profile.d/nix.sh" \
    NIX_CONFIG="experimental-features = nix-command flakes"

# Install mise — declarative tool manager (baseline: rg, python, yq)
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
# /data/nix-env/bin — Nix-managed knight tools (from flake.nix via ConfigMap)
# /data/bin — legacy persistent binaries (fallback for non-Nix knights)
# /data/.mise/shims — mise-managed tools (knight-specific)
# /app/.mise/shims — baseline tools (rg, python, yq)
ENV NODE_ENV=production \
    MISE_DATA_DIR=/data/.mise \
    MISE_YES=1 \
    PATH="/data/nix-env/bin:/data/bin:/data/.mise/shims:/app/.mise/shims:${PATH}"

# Non-root (node:22-slim already has 'node' user at uid 1000)
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
