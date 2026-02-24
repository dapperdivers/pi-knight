#!/bin/sh
# mise-init.sh — Install knight-specific tools at pod startup.
# Runs as an init container before the main pi-knight process.
#
# Two sources of knight-specific tools:
#   1. /config/mise.toml  — declarative CLI tools (mise install)
#   2. /config/apt.txt    — system packages (apt-get install)
#
# Both are optional. If neither exists, the knight runs on baseline tools only.

set -e

# --- System packages (apt) ---
APT_FILE="/config/apt.txt"
if [ -f "$APT_FILE" ]; then
  echo "Installing system packages from $APT_FILE..."
  apt-get update -qq
  xargs -a "$APT_FILE" apt-get install -y --no-install-recommends
  rm -rf /var/lib/apt/lists/*
  echo "System packages installed."
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

if [ ! -f "$APT_FILE" ] && [ ! -f "$MISE_TOML" ]; then
  echo "No knight-specific tools configured — using image baseline only."
fi
