#!/bin/bash
# entrypoint.sh — Pi-Knight startup with PVC-native Nix
#
# Architecture:
#   - /nix is a PVC mount (empty on first boot, persistent after)
#   - Nix installer tarball is cached in the image at /opt/nix-cache/
#   - First boot: install Nix to PVC (~30s), build flake tools (~1-3min)
#   - Subsequent boots: everything cached on PVC (~2s)
#   - NO init containers needed for Nix
#
# Mount requirements:
#   /nix   → PVC (the entire Nix store + profiles)
#   /data  → PVC (workspace, memory, mise tools)
#   /config → ConfigMap (SOUL.md, flake.nix, etc.)

set -eo pipefail

log() { echo "[entrypoint] $(date '+%H:%M:%S') $*"; }

# ──────────────────────────────────────────────────────────────────
# Phase 1: Workspace seeding (from defaults + ConfigMap)
# ──────────────────────────────────────────────────────────────────
log "Phase 1: Workspace"
mkdir -p /data/memory

# Seed operational files from image defaults (only if missing on PVC)
if [ -d /app/defaults ]; then
  for f in /app/defaults/*.md; do
    fname=$(basename "$f")
    [ ! -f "/data/$fname" ] && cp "$f" "/data/$fname" && log "  Seeded $fname"
  done
fi

# Seed personality files from ConfigMap (only if missing on PVC)
for f in SOUL.md IDENTITY.md TOOLS.md; do
  if [ ! -f "/data/$f" ] && [ -f "/config/$f" ]; then
    cp "/config/$f" "/data/$f"
    log "  Seeded $f from ConfigMap"
  fi
done

# ──────────────────────────────────────────────────────────────────
# Phase 2: Nix bootstrap (first boot only)
# ──────────────────────────────────────────────────────────────────
NIX_PROFILE="$HOME/.nix-profile"
NIX_CONF="/nix/etc/nix/nix.conf"

bootstrap_nix() {
  log "Phase 2: Installing Nix to PVC (first boot)..."

  # Create directory structure Nix expects
  mkdir -p /nix/store /nix/var/nix/profiles/per-user/node \
           /nix/var/nix/gcroots/per-user/node /nix/etc/nix

  # Write nix.conf for single-user mode with flakes
  cat > "$NIX_CONF" <<'EOF'
build-users-group =
experimental-features = nix-command flakes
sandbox = false
max-jobs = auto
EOF

  # Extract cached installer tarball
  CACHE_TAR=$(ls /opt/nix-cache/nix-*.tar.xz 2>/dev/null | head -1)
  if [ -z "$CACHE_TAR" ]; then
    log "  ERROR: No cached Nix installer found"
    return 1
  fi

  TMPDIR=$(mktemp -d)
  log "  Extracting installer..."
  tar xf "$CACHE_TAR" -C "$TMPDIR"

  # The tarball extracts to nix-<version>-<arch>/ with a store/ directory
  INSTALLER_DIR=$(find "$TMPDIR" -maxdepth 1 -name 'nix-*' -type d | head -1)
  if [ -z "$INSTALLER_DIR" ] || [ ! -d "$INSTALLER_DIR/store" ]; then
    log "  ERROR: Unexpected installer layout in $TMPDIR"
    ls -la "$TMPDIR"
    return 1
  fi

  # Copy store paths from the installer
  log "  Copying store paths..."
  cp -a "$INSTALLER_DIR/store/"* /nix/store/

  # Find the nix binary and create profile links
  NIX_STORE_PATH=$(find /nix/store -maxdepth 1 -name '*-nix-*' -type d | grep -v '\.drv$' | head -1)
  if [ -z "$NIX_STORE_PATH" ] || [ ! -x "$NIX_STORE_PATH/bin/nix" ]; then
    # Try harder — look for the actual binary
    NIX_STORE_PATH=$(find /nix/store -name 'nix' -executable -path '*/bin/nix' -printf '%h/..\n' 2>/dev/null | head -1)
    NIX_STORE_PATH=$(cd "$NIX_STORE_PATH" 2>/dev/null && pwd)
  fi

  if [ -z "$NIX_STORE_PATH" ] || [ ! -x "$NIX_STORE_PATH/bin/nix" ]; then
    log "  ERROR: Could not find nix binary in store"
    find /nix/store -name 'nix' -executable 2>/dev/null | head -5
    return 1
  fi

  log "  Nix store path: $NIX_STORE_PATH"

  # Create profile symlink
  mkdir -p "$(dirname "$NIX_PROFILE")"
  ln -sfn "$NIX_STORE_PATH" "$NIX_PROFILE"

  # Register the profile
  ln -sfn "$NIX_PROFILE" /nix/var/nix/profiles/per-user/node/profile

  rm -rf "$TMPDIR"

  # Mark as bootstrapped
  touch /nix/.bootstrapped
  log "  Nix installed ✓ ($(du -sh /nix/store | cut -f1))"
}

if [ -d /nix ] && [ -w /nix ]; then
  if [ ! -f /nix/.bootstrapped ]; then
    bootstrap_nix
  else
    log "Phase 2: Nix already bootstrapped ✓"
    # Restore profile symlink if missing (stale PVC / domain change)
    if [ ! -d "$NIX_PROFILE/bin" ]; then
      log "  Profile symlink broken — restoring..."
      NIX_STORE_PATH=$(find /nix/store -maxdepth 1 -name '*-nix-*' -type d 2>/dev/null | grep -v '\.drv$' | head -1)
      if [ -n "$NIX_STORE_PATH" ] && [ -x "$NIX_STORE_PATH/bin/nix" ]; then
        mkdir -p "$(dirname "$NIX_PROFILE")"
        ln -sfn "$NIX_STORE_PATH" "$NIX_PROFILE"
        log "  Profile restored → $NIX_STORE_PATH"
      else
        log "  WARNING: Could not find nix binary in store — re-bootstrapping"
        rm -f /nix/.bootstrapped
        bootstrap_nix
      fi
    fi
  fi
else
  log "Phase 2: No /nix mount — skipping Nix bootstrap"
fi

# Source Nix into PATH
if [ -d "$NIX_PROFILE/bin" ]; then
  export PATH="$NIX_PROFILE/bin:$PATH"
  export NIX_CONF_DIR="/nix/etc/nix"
  log "  Nix $(nix --version 2>/dev/null || echo 'binary found')"
fi

# ──────────────────────────────────────────────────────────────────
# Phase 3: Flake tool installation (content-addressed, cached)
# ──────────────────────────────────────────────────────────────────
FLAKE_FILE="/config/flake.nix"
NIX_ENV="/data/nix-env"
HASH_FILE="/data/.nix-flake-hash"

if [ -f "$FLAKE_FILE" ] && command -v nix >/dev/null 2>&1; then
  NEW_HASH=$(sha256sum "$FLAKE_FILE" | cut -d' ' -f1)

  if [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE")" = "$NEW_HASH" ] \
     && [ -d "$NIX_ENV/bin" ] && [ "$(ls "$NIX_ENV/bin/" 2>/dev/null | wc -l)" -gt 0 ]; then
    # Verify a symlink actually resolves
    FIRST_BIN=$(ls "$NIX_ENV/bin/" | head -1)
    if [ -x "$NIX_ENV/bin/$FIRST_BIN" ] 2>/dev/null; then
      log "Phase 3: Flake tools cached ($(ls "$NIX_ENV/bin/" | wc -l) tools) ✓"
    else
      log "Phase 3: Flake cache broken — rebuilding"
      rm -f "$HASH_FILE"
    fi
  fi

  # Build if not cached
  if [ ! -f "$HASH_FILE" ] || [ "$(cat "$HASH_FILE")" != "$NEW_HASH" ]; then
    log "Phase 3: Building flake tools..."

    BUILD_DIR=$(mktemp -d)
    cp "$FLAKE_FILE" "$BUILD_DIR/flake.nix"
    cd "$BUILD_DIR"

    if STORE_PATH=$(nix build ".#default" --no-link --print-out-paths 2>&1); then
      STORE_PATH=$(echo "$STORE_PATH" | tail -1)
      if [ -d "$STORE_PATH" ]; then
        rm -rf "$NIX_ENV" 2>/dev/null || true
        cp -a "$STORE_PATH" "$NIX_ENV"
        echo "$NEW_HASH" > "$HASH_FILE"
        log "  Flake tools ready: $(ls "$NIX_ENV/bin/" | wc -l) tools"
      else
        log "  WARNING: Nix build produced invalid path: $STORE_PATH"
      fi
    else
      log "  WARNING: Nix flake build failed (non-fatal):"
      echo "$STORE_PATH" | tail -5
    fi

    rm -rf "$BUILD_DIR"
    cd /app
  fi
else
  log "Phase 3: No flake.nix or no Nix — skipping"
fi

# ──────────────────────────────────────────────────────────────────
# Phase 4: Mise tools (if any per-knight config)
# ──────────────────────────────────────────────────────────────────
if [ -f /config/mise.toml ] && command -v mise >/dev/null 2>&1; then
  log "Phase 4: Mise tools"
  /app/scripts/mise-init.sh 2>&1 | sed 's/^/  /' || log "  WARNING: mise init failed (non-fatal)"
else
  log "Phase 4: No mise config — skipping"
fi

# ──────────────────────────────────────────────────────────────────
# Phase 4.5: Vault write check
# ──────────────────────────────────────────────────────────────────
if [ -d "/vault" ]; then
  VAULT_WRITABLE="false"
  for wpath in Briefings Roundtable; do
    if [ -d "/vault/$wpath" ]; then
      if touch "/vault/$wpath/.write-test" 2>/dev/null; then
        rm -f "/vault/$wpath/.write-test"
        VAULT_WRITABLE="true"
      fi
    fi
  done
  if [ "$VAULT_WRITABLE" = "true" ]; then
    log "Phase 4.5: Vault writable paths verified ✓"
    export VAULT_WRITABLE=true
  else
    log "  WARNING: Vault mounted but writable paths NOT writable"
    export VAULT_WRITABLE=false
  fi
else
  log "Phase 4.5: No vault mount — skipping"
fi

# Phase 5: Start the knight
# ──────────────────────────────────────────────────────────────────
# Set PATH with tool priority
export PATH="/data/nix-env/bin:/data/bin:/data/.mise/shims:/app/.mise/shims:$PATH"

log "Phase 5: Starting pi-knight"
exec node dist/index.js
