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

# ── Legacy cleanup ──
# Remove root-owned files from previous 3-container Nix approach.
# These can't be deleted by uid 1000 with rm, but mv to a .old suffix works.
if [ -d "$NIX_ENV" ] && ! rm -rf "$NIX_ENV" 2>/dev/null; then
  echo "Cleaning up root-owned legacy nix-env..."
  mv "$NIX_ENV" "${NIX_ENV}.old.$$" 2>/dev/null || true
fi
rm -f /data/.nix-flake-hash.old 2>/dev/null || true

if [ ! -f "$FLAKE_FILE" ]; then
  echo "No flake.nix at $FLAKE_FILE — skipping Nix init."
  exit 0
fi

# Add Nix to PATH — the single-user install puts binaries in a profile
# Try multiple locations (root install vs user install vs default profile)
for candidate in \
  /nix/var/nix/profiles/default/bin \
  /root/.nix-profile/bin \
  "$HOME/.nix-profile/bin"; do
  if [ -d "$candidate" ] && [ -x "$candidate/nix" ]; then
    export PATH="$candidate:$PATH"
    echo "Nix found at: $candidate ($(nix --version))"
    break
  fi
done

if ! command -v nix >/dev/null 2>&1; then
  echo "ERROR: Nix not found"
  echo "Searched: /nix/var/nix/profiles/default/bin, /root/.nix-profile/bin, \$HOME/.nix-profile/bin"
  ls -la /nix/var/nix/profiles/ 2>/dev/null || echo "No profiles dir"
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

# Build — capture both stdout and stderr for diagnostics
echo "  Running: nix build .#default --no-link --print-out-paths"
echo "  Flake dir contents: $(ls "$FLAKE_DIR")"
echo "  Nix version: $(nix --version 2>&1 || echo 'nix not found on PATH')"
if ! STORE_PATH=$(nix build ".#default" --no-link --print-out-paths 2>&1); then
  echo "ERROR: Nix build failed:"
  echo "$STORE_PATH"
  exit 1
fi

# nix build output might have progress on stderr mixed in — last line is the store path
STORE_PATH=$(echo "$STORE_PATH" | tail -1)
if [ -z "$STORE_PATH" ] || [ ! -d "$STORE_PATH" ]; then
  echo "ERROR: Nix build produced invalid store path: '$STORE_PATH'"
  exit 1
fi

echo "  Store path: $STORE_PATH"

# Create the env profile — symlinks in bin/ point to /nix/store/... paths
# which are directly accessible (same filesystem, no copying needed)
# Note: old nix-env may have root-owned files from previous 3-container approach
rm -rf "$NIX_ENV" 2>/dev/null || {
  echo "  Warning: old nix-env has root files, moving aside..."
  mv "$NIX_ENV" "${NIX_ENV}.old" 2>/dev/null || true
}
cp -a "$STORE_PATH" "$NIX_ENV"

# Save hash for caching
echo "$NEW_HASH" > "$HASH_FILE"
echo "Nix env ready: $(ls "$NIX_ENV/bin/" | wc -l) tools"
ls "$NIX_ENV/bin/" | head -30
