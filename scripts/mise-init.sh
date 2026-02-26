#!/bin/sh
# mise-init.sh — Install knight-specific tools at pod startup.
# Runs as an init container before the main pi-knight process.
#
# Three sources of knight-specific tools:
#   1. /config/apt.txt    — system packages (apt-get install)
#   2. /config/pip.txt    — Python packages (pip install)
#   3. /config/mise.toml  — declarative CLI tools (mise install)
#
# All are optional. If none exist, the knight runs on baseline tools only.
#
# IMPORTANT: Init containers have separate filesystem overlays from app containers.
# apt packages installed normally would NOT be visible to the app container.
# We solve this by copying installed binaries + their library deps to /data/bin/
# and /data/lib/ on the shared PVC volume, then the app container adds these to
# PATH and LD_LIBRARY_PATH.

set -e

PERSIST_BIN="/data/bin"
PERSIST_LIB="/data/lib"

# --- System packages (apt) ---
APT_FILE="/config/apt.txt"
if [ -f "$APT_FILE" ]; then
  echo "Installing system packages from $APT_FILE..."

  # Snapshot existing binaries so we can detect what's new
  ls /usr/bin/ /usr/sbin/ /usr/local/bin/ 2>/dev/null | sort > /tmp/bins-before.txt

  apt-get update -qq
  xargs -a "$APT_FILE" apt-get install -y --no-install-recommends
  rm -rf /var/lib/apt/lists/*
  echo "System packages installed."

  # Persist newly installed binaries + shared libraries to PVC
  mkdir -p "$PERSIST_BIN" "$PERSIST_LIB"
  ls /usr/bin/ /usr/sbin/ /usr/local/bin/ 2>/dev/null | sort > /tmp/bins-after.txt
  NEW_BINS=$(comm -13 /tmp/bins-before.txt /tmp/bins-after.txt)

  for bin in $NEW_BINS; do
    for dir in /usr/bin /usr/sbin /usr/local/bin; do
      if [ -f "$dir/$bin" ]; then
        cp -a "$dir/$bin" "$PERSIST_BIN/$bin"
        echo "  Persisted: $bin"
        # Copy shared library dependencies
        ldd "$dir/$bin" 2>/dev/null | grep "=> /" | awk '{print $3}' | while read lib; do
          libname=$(basename "$lib")
          if [ ! -f "$PERSIST_LIB/$libname" ]; then
            cp -aL "$lib" "$PERSIST_LIB/$libname" 2>/dev/null || true
          fi
        done
        break
      fi
    done
  done

  # Also persist key data directories some tools need (e.g., nmap scripts)
  if [ -d /usr/share/nmap ]; then
    mkdir -p /data/share
    cp -a /usr/share/nmap /data/share/nmap
    echo "  Persisted: nmap data files"
  fi
  if [ -d /usr/share/sslscan ]; then
    mkdir -p /data/share
    cp -a /usr/share/sslscan /data/share/sslscan
    echo "  Persisted: sslscan data files"
  fi

  # Copy perl for tools that need it (nikto, sslscan)
  if [ -d /usr/share/perl ] && [ ! -d /data/share/perl ]; then
    mkdir -p /data/share
    cp -a /usr/share/perl /data/share/perl
    cp -a /usr/lib/x86_64-linux-gnu/perl 2>/dev/null /data/lib/ || true
  fi

  echo "Persisted $(ls "$PERSIST_BIN" | wc -l) binaries to $PERSIST_BIN"
fi

# --- pip packages ---
PIP_FILE="/config/pip.txt"
if [ -f "$PIP_FILE" ]; then
  echo "Installing Python packages from $PIP_FILE..."
  pip install --no-cache-dir -r "$PIP_FILE"
  echo "Python packages installed."
fi

# --- mise tools ---
MISE_TOML="/config/mise.toml"
if [ -f "$MISE_TOML" ]; then
  echo "Installing knight-specific tools from $MISE_TOML..."
  export MISE_DATA_DIR="/data/.mise"
  export MISE_CONFIG_FILE="$MISE_TOML"
  export MISE_YES=1
  mise install
  mise reshim
  echo "Knight tools installed to /data/.mise/shims:"
  ls /data/.mise/shims/ 2>/dev/null || echo "(none)"
fi

if [ ! -f "$APT_FILE" ] && [ ! -f "$PIP_FILE" ] && [ ! -f "$MISE_TOML" ]; then
  echo "No knight-specific tools configured — using image baseline only."
fi
