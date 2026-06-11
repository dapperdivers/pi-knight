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
mkdir -p /data/memory /data/session-notes /data/scratch

# Seed operational files from image defaults (only if missing on PVC)
if [ -d /app/defaults ]; then
  for f in /app/defaults/*.md; do
    fname=$(basename "$f")
    [ ! -f "/data/$fname" ] && cp "$f" "/data/$fname" && log "  Seeded $fname"
  done
fi

# Sync personality files from ConfigMap → PVC (hash-gated)
# Only overwrites when ConfigMap content actually changed.
# Knights can self-modify /data/ files, but CRD-driven changes win.
mkdir -p /data/.config-hashes
for f in SOUL.md IDENTITY.md TOOLS.md; do
  if [ -f "/config/$f" ]; then
    config_hash=$(md5sum "/config/$f" | cut -d' ' -f1)
    stored_hash=""
    [ -f "/data/.config-hashes/$f" ] && stored_hash=$(cat "/data/.config-hashes/$f")
    if [ "$config_hash" != "$stored_hash" ]; then
      cp "/config/$f" "/data/$f"
      echo "$config_hash" > "/data/.config-hashes/$f"
      if [ -z "$stored_hash" ]; then
        log "  Seeded $f from ConfigMap"
      else
        log "  Updated $f from ConfigMap (hash changed)"
      fi
    fi
  fi
done

# ──────────────────────────────────────────────────────────────────
# Phase 1.5: Optional Pi model provider bootstrap
# ──────────────────────────────────────────────────────────────────
# Allows per-knight native provider configuration (for example Ollama)
# without baking models.json into the image. Written to /data/models.json —
# the runtime's agentDir is /data, so that is where ModelRegistry reads it.
if [ -n "${PI_MODELS_JSON_B64:-}" ] || [ -n "${PI_MODELS_JSON:-}" ]; then
  mkdir -p /data
  if [ -n "${PI_MODELS_JSON_B64:-}" ]; then
    printf '%s' "$PI_MODELS_JSON_B64" | base64 -d > /data/models.json
    log "Phase 1.5: Wrote /data/models.json from PI_MODELS_JSON_B64"
  else
    printf '%s\n' "$PI_MODELS_JSON" > /data/models.json
    log "Phase 1.5: Wrote /data/models.json from PI_MODELS_JSON"
  fi
else
  log "Phase 1.5: No custom Pi model config — skipping"
fi

# ──────────────────────────────────────────────────────────────────
# Phase 2: Nix bootstrap (first boot only)
# ──────────────────────────────────────────────────────────────────
# Three modes:
#   - /nix read-only  → shared store; tools prebuilt by the operator's build
#     Job. Skip bootstrap/build, just source the per-knight profile.
#   - /nix writable   → per-pod PVC store (legacy). Bootstrap + build locally.
#   - no /nix         → skip Nix entirely.
NIX_PROFILE="$HOME/.nix-profile"
NIX_SHARED_STORE="false"

# shellcheck source=scripts/nix-lib.sh
. /app/scripts/nix-lib.sh

if [ -d /nix ] && [ ! -w /nix ]; then
  # Shared read-only store — tools come from the operator-published profile.
  NIX_SHARED_STORE="true"
  KNIGHT_NIX_PROFILE="${KNIGHT_NIX_PROFILE:-/nix/var/nix/profiles/knights/$(echo "${KNIGHT_NAME:-}" | tr '[:upper:]' '[:lower:]')}"
  if [ -d "$KNIGHT_NIX_PROFILE/bin" ]; then
    export PATH="$KNIGHT_NIX_PROFILE/bin:$PATH"
    export NIX_CONF_DIR="/nix/etc/nix"
    log "Phase 2: Shared Nix store (read-only) — profile $KNIGHT_NIX_PROFILE ✓"
  else
    log "Phase 2: Shared Nix store mounted but no profile at $KNIGHT_NIX_PROFILE yet (build pending)"
  fi
elif [ -d /nix ] && [ -w /nix ]; then
  rt_bootstrap_nix
  rt_restore_profile
  if rt_source_nix; then
    log "Phase 2: Nix ready — $(nix --version 2>/dev/null || echo 'binary found')"
  fi
else
  log "Phase 2: No /nix mount — skipping Nix bootstrap"
fi

# ──────────────────────────────────────────────────────────────────
# Phase 3: Flake tool installation (content-addressed, cached)
# ──────────────────────────────────────────────────────────────────
FLAKE_FILE="/config/flake.nix"
NIX_ENV="/data/nix-env"
HASH_FILE="/data/.nix-flake-hash"

if [ "$NIX_SHARED_STORE" = "true" ]; then
  log "Phase 3: Shared store — flake tools prebuilt by operator, skipping local build"
elif [ -f "$FLAKE_FILE" ] && command -v nix >/dev/null 2>&1; then
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
        chmod -R u+w "$NIX_ENV" 2>/dev/null || true
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

# Phase 4.9: Git credential setup
# ──────────────────────────────────────────────────────────────────
# Configure gh as the git credential helper so knights can push over HTTPS.
# GH_TOKEN / GITHUB_TOKEN env vars are injected via secrets — gh CLI uses them
# automatically, but git push needs credential.helper to bridge the gap.
if command -v gh >/dev/null 2>&1; then
  git config --global credential.helper '!gh auth git-credential'
  log "Phase 4.9: Git credential helper configured (gh) ✓"
elif [ -n "$GH_TOKEN" ]; then
  # Fallback: write a static credential helper using GH_TOKEN directly
  git config --global credential.helper store
  echo "https://x-access-token:${GH_TOKEN}@github.com" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
  log "Phase 4.9: Git credential helper configured (token store) ✓"
else
  log "Phase 4.9: No git credentials available — push will fail"
fi

# Phase 5: Start the knight
# ──────────────────────────────────────────────────────────────────
# Set PATH with tool priority
export PATH="/data/nix-env/bin:/data/bin:/data/.mise/shims:/app/.mise/shims:$PATH"

log "Phase 5: Starting pi-knight"
exec node dist/index.js
