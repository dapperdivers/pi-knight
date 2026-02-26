#!/bin/sh
# nix-init.sh — Build knight-specific tools from a Nix flake.
# Runs as part of the init sequence (root). The flake.nix comes from ConfigMap.
#
# Architecture:
#   - Nix is installed in the base image (single-user, no daemon)
#   - flake.nix is mounted at /config/flake.nix via ConfigMap
#   - Tools are built into /nix/store (persistent across container restarts
#     if /nix is on a volume, ephemeral otherwise)
#   - A symlink profile at /data/nix-env/bin/ is created for PATH
#
# Content-addressed caching:
#   - SHA256 of flake.nix stored at /data/.nix-flake-hash
#   - Skips rebuild if hash matches AND /nix/store has the built env

set -e

FLAKE_FILE="/config/flake.nix"
NIX_ENV="/data/nix-env"
HASH_FILE="/data/.nix-flake-hash"

if [ ! -f "$FLAKE_FILE" ]; then
  echo "No flake.nix at $FLAKE_FILE — skipping Nix init."
  exit 0
fi

# Source the Nix profile
NIX_SH="${NIX_PROFILE_SCRIPT:-/root/.nix-profile/etc/profile.d/nix.sh}"
if [ -f "$NIX_SH" ]; then
  . "$NIX_SH"
else
  echo "ERROR: Nix profile not found at $NIX_SH"
  exit 1
fi

# Content-addressed cache check
NEW_HASH=$(sha256sum "$FLAKE_FILE" | cut -d' ' -f1)
if [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE")" = "$NEW_HASH" ] \
   && [ -d "$NIX_ENV/bin" ] && [ "$(ls "$NIX_ENV/bin/" 2>/dev/null | wc -l)" -gt 0 ]; then
  # Verify a symlink actually resolves (guards against stale /nix/store)
  FIRST_BIN=$(ls "$NIX_ENV/bin/" | head -1)
  if [ -x "$NIX_ENV/bin/$FIRST_BIN" ] 2>/dev/null; then
    echo "Nix env cached ($(ls "$NIX_ENV/bin/" | wc -l) tools) — skipping."
    exit 0
  fi
  echo "Nix env cached but broken — rebuilding..."
fi

echo "Building Nix tool environment..."

# Copy flake to a build directory (nix build scans cwd)
FLAKE_DIR="/tmp/nix-build"
rm -rf "$FLAKE_DIR"
mkdir -p "$FLAKE_DIR"
cp "$FLAKE_FILE" "$FLAKE_DIR/flake.nix"
cd "$FLAKE_DIR"

# Build — stdout is the store path, stderr is progress
STORE_PATH=$(nix build ".#default" --no-link --print-out-paths 2>/tmp/nix-build-log.txt)
BUILD_EXIT=$?

if [ $BUILD_EXIT -ne 0 ] || [ -z "$STORE_PATH" ]; then
  echo "ERROR: Nix build failed:"
  cat /tmp/nix-build-log.txt
  exit 1
fi

echo "  Store path: $STORE_PATH"

# Create the env profile — symlinks in bin/ point to /nix/store/... paths
# which are directly accessible (same filesystem, no copying needed)
rm -rf "$NIX_ENV"
cp -a "$STORE_PATH" "$NIX_ENV"

# Save hash for caching
echo "$NEW_HASH" > "$HASH_FILE"
echo "Nix env ready: $(ls "$NIX_ENV/bin/" | wc -l) tools"
ls "$NIX_ENV/bin/" | head -30
