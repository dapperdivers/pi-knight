#!/bin/bash
# nix-lib.sh — shared Nix bootstrap helpers.
#
# Sourced by both entrypoint.sh (per-pod, read-write PVC) and nix-build.sh
# (the shared-store builder Job). Keeping the bootstrap in one place stops the
# two paths from drifting — historically a source of crashloop bugs.
#
# Expects: NIX_PROFILE (defaults to $HOME/.nix-profile). Operates on /nix.

NIX_PROFILE="${NIX_PROFILE:-$HOME/.nix-profile}"
NIX_CONF="/nix/etc/nix/nix.conf"

# rt_log — namespaced logger; callers may override.
rt_log() { echo "[nix-lib] $(date '+%H:%M:%S') $*"; }

# rt_write_nix_conf — single-user nix.conf with the public binary cache so
# tools substitute from cache.nixos.org instead of building from source.
rt_write_nix_conf() {
  mkdir -p /nix/etc/nix
  cat > "$NIX_CONF" <<'EOF'
build-users-group =
experimental-features = nix-command flakes
sandbox = false
max-jobs = auto
substituters = https://cache.nixos.org/
trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=
EOF
}

# rt_bootstrap_nix — install Nix into /nix from the image-cached installer
# tarball if not already present. Idempotent. Returns non-zero on failure.
rt_bootstrap_nix() {
  if [ -f /nix/.bootstrapped ] && [ -d "$NIX_PROFILE/bin" ]; then
    return 0
  fi

  rt_log "Installing Nix to PVC..."
  mkdir -p /nix/store /nix/var/nix/profiles/per-user/node \
           /nix/var/nix/gcroots/per-user/node /nix/etc/nix
  rt_write_nix_conf

  local cache_tar
  cache_tar=$(ls /opt/nix-cache/nix-*.tar.xz 2>/dev/null | head -1)
  if [ -z "$cache_tar" ]; then
    rt_log "  ERROR: No cached Nix installer found"
    return 1
  fi

  # Local var, NOT TMPDIR: overwriting the inherited TMPDIR and then rm-ing it
  # leaves later mktemp calls pointing at a deleted base dir.
  local installer_tmp
  installer_tmp=$(mktemp -d)
  rt_log "  Extracting installer..."
  tar xf "$cache_tar" -C "$installer_tmp"

  local installer_dir
  installer_dir=$(find "$installer_tmp" -maxdepth 1 -name 'nix-*' -type d | head -1)
  if [ -z "$installer_dir" ] || [ ! -d "$installer_dir/store" ]; then
    rt_log "  ERROR: Unexpected installer layout in $installer_tmp"
    rm -rf "$installer_tmp"
    return 1
  fi

  rt_log "  Copying store paths..."
  cp -a "$installer_dir/store/"* /nix/store/

  local nix_store_path
  nix_store_path=$(find /nix/store -maxdepth 1 -name '*-nix-*' -type d | grep -v '\.drv$' | head -1)
  if [ -z "$nix_store_path" ] || [ ! -x "$nix_store_path/bin/nix" ]; then
    nix_store_path=$(find /nix/store -name 'nix' -executable -path '*/bin/nix' -printf '%h/..\n' 2>/dev/null | head -1)
    nix_store_path=$(cd "$nix_store_path" 2>/dev/null && pwd)
  fi
  if [ -z "$nix_store_path" ] || [ ! -x "$nix_store_path/bin/nix" ]; then
    rt_log "  ERROR: Could not find nix binary in store"
    rm -rf "$installer_tmp"
    return 1
  fi
  rt_log "  Nix store path: $nix_store_path"

  mkdir -p "$(dirname "$NIX_PROFILE")"
  ln -sfn "$nix_store_path" "$NIX_PROFILE"
  ln -sfn "$NIX_PROFILE" /nix/var/nix/profiles/per-user/node/profile

  rm -rf "$installer_tmp"
  touch /nix/.bootstrapped
  rt_log "  Nix installed ✓ ($(du -sh /nix/store 2>/dev/null | cut -f1))"
}

# rt_restore_profile — repair a broken profile symlink on an already-bootstrapped
# store (stale PVC / domain change). Re-bootstraps if the binary is gone.
rt_restore_profile() {
  if [ -d "$NIX_PROFILE/bin" ]; then
    return 0
  fi
  rt_log "Profile symlink broken — restoring..."
  local nix_store_path
  nix_store_path=$(find /nix/store -maxdepth 1 -name '*-nix-*' -type d 2>/dev/null | grep -v '\.drv$' | head -1)
  if [ -n "$nix_store_path" ] && [ -x "$nix_store_path/bin/nix" ]; then
    mkdir -p "$(dirname "$NIX_PROFILE")"
    ln -sfn "$nix_store_path" "$NIX_PROFILE"
    rt_log "  Profile restored → $nix_store_path"
  else
    rt_log "  WARNING: nix binary missing — re-bootstrapping"
    rm -f /nix/.bootstrapped
    rt_bootstrap_nix
  fi
}

# rt_source_nix — put Nix on PATH for the current shell.
rt_source_nix() {
  if [ -d "$NIX_PROFILE/bin" ]; then
    export PATH="$NIX_PROFILE/bin:$PATH"
    export NIX_CONF_DIR="/nix/etc/nix"
    return 0
  fi
  return 1
}
