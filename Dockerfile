FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim
WORKDIR /app

# System packages — minimal base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Cache Nix installer tarball (avoids download on every fresh PVC) ──
# We DON'T install Nix into the image — it lives entirely on the PVC.
# This just caches the ~20MB tarball so first boot is faster.
ARG NIX_VERSION=2.28.3
RUN curl -L "https://releases.nixos.org/nix/nix-${NIX_VERSION}/nix-${NIX_VERSION}-x86_64-linux.tar.xz" \
      -o /tmp/nix-installer.tar.xz \
    && mkdir -p /opt/nix-cache \
    && mv /tmp/nix-installer.tar.xz /opt/nix-cache/

# ── Mise (baseline tools) ────────────────────────────────────────
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh
COPY mise.toml /app/mise.toml
ENV MISE_DATA_DIR=/app/.mise \
    MISE_CONFIG_FILE=/app/mise.toml \
    MISE_YES=1
RUN mise install --cd /app && mise reshim

# ── App code ──────────────────────────────────────────────────────
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY defaults/ ./defaults/
COPY scripts/ ./scripts/

# ── Runtime ───────────────────────────────────────────────────────
ENV NODE_ENV=production \
    MISE_DATA_DIR=/data/.mise \
    MISE_YES=1

# Non-root
USER node

EXPOSE 3000
CMD ["/app/scripts/entrypoint.sh"]
