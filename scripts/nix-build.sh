#!/bin/bash
# nix-build.sh — shared-store builder (runs in the operator's nix-build Job).
#
# Mounts the shared Nix store RW at /nix (one writer; knights mount it RO) and
# the knight's ConfigMap at /config. Builds the knight's flake and publishes a
# per-knight profile at /nix/var/nix/profiles/knights/<KNIGHT_NAME> that the
# knight pod sources read-only.
#
# Store writes are serialized with a flock so concurrent per-knight build Jobs
# can't race on the Nix SQLite db (single-user mode, no nix-daemon).
#
# Env:
#   KNIGHT_NAME  — profile name to publish (required)
#   FLAKE_FILE   — flake path (default /config/flake.nix)
#   TMPDIR       — writable scratch (default /tmp); must NOT be on /nix (RO-safe)
set -eo pipefail

log() { echo "[nix-build] $(date '+%H:%M:%S') $*"; }

KNIGHT_NAME="${KNIGHT_NAME:?KNIGHT_NAME is required}"
FLAKE_FILE="${FLAKE_FILE:-/config/flake.nix}"
LOCK_FILE="/nix/var/.roundtable-build.lock"
PROFILE_DIR="/nix/var/nix/profiles/knights"
PROFILE="$PROFILE_DIR/$KNIGHT_NAME"

# shellcheck source=/dev/null
. "$(dirname "$0")/nix-lib.sh"

if [ ! -w /nix ]; then
  log "ERROR: /nix is not writable — builder needs the store mounted RW"
  exit 1
fi
if [ ! -f "$FLAKE_FILE" ]; then
  log "ERROR: no flake at $FLAKE_FILE"
  exit 1
fi

mkdir -p /nix/var "$PROFILE_DIR"

# ── Critical section: serialize all store mutations across build Jobs ──
exec 9>"$LOCK_FILE"
log "Waiting for store lock..."
flock 9
log "Acquired store lock"

rt_bootstrap_nix || { log "ERROR: bootstrap failed"; exit 1; }
rt_restore_profile
rt_source_nix || { log "ERROR: nix not on PATH after bootstrap"; exit 1; }
log "Nix $(nix --version 2>/dev/null)"

# Build the flake into the shared store. --print-out-paths gives the buildEnv
# store path; we root it as the knight's profile so GC won't reap it.
BUILD_DIR=$(mktemp -d)
cp "$FLAKE_FILE" "$BUILD_DIR/flake.nix"

log "Building flake for $KNIGHT_NAME..."
if STORE_PATH=$(cd "$BUILD_DIR" && nix build ".#default" --no-link --print-out-paths 2>&1); then
  STORE_PATH=$(echo "$STORE_PATH" | tail -1)
else
  log "ERROR: nix build failed:"
  echo "$STORE_PATH" | tail -15
  rm -rf "$BUILD_DIR"
  exit 1
fi
rm -rf "$BUILD_DIR"

if [ ! -d "$STORE_PATH/bin" ]; then
  log "ERROR: build produced no bin/ at $STORE_PATH"
  exit 1
fi

# Publish the profile (atomic symlink swap). Entries under .../profiles are GC
# roots, so the closure is protected.
ln -sfn "$STORE_PATH" "$PROFILE.tmp"
mv -fT "$PROFILE.tmp" "$PROFILE"
log "Published profile $PROFILE → $STORE_PATH ($(ls "$STORE_PATH/bin" | wc -l) tools)"
