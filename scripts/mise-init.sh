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

  # Copy perl modules for tools that need them (nikto needs JSON, XML::Writer)
  mkdir -p /data/share/perl5
  # Copy all perl module directories to a single persistent location
  for pdir in /usr/share/perl5 /usr/share/perl/5.36 /usr/share/perl/5.36.0 \
              /usr/lib/x86_64-linux-gnu/perl5/5.36 /usr/lib/x86_64-linux-gnu/perl/5.36; do
    if [ -d "$pdir" ]; then
      cp -a "$pdir"/* /data/share/perl5/ 2>/dev/null || true
    fi
  done
  echo "  Persisted: perl modules"

  echo "Persisted $(ls "$PERSIST_BIN" | wc -l) binaries to $PERSIST_BIN"
fi

# --- Static binary downloads (bins.txt) ---
# Format: one URL per line, downloaded to /data/bin/
# Supports .zip archives (extracts all executables)
BINS_FILE="/config/bins.txt"
if [ -f "$BINS_FILE" ]; then
  echo "Downloading static binaries from $BINS_FILE..."
  mkdir -p "$PERSIST_BIN"
  while IFS= read -r url || [ -n "$url" ]; do
    url=$(echo "$url" | sed 's/#.*//' | xargs)  # strip comments and whitespace
    [ -z "$url" ] && continue
    fname=$(basename "$url")
    echo "  Downloading: $fname"
    TMP_DL="/tmp/bin-dl-$fname"
    if curl -sL "$url" -o "$TMP_DL" 2>/dev/null && [ -s "$TMP_DL" ]; then
      case "$fname" in
        *.zip)
          if command -v unzip &>/dev/null; then
            unzip -o -q "$TMP_DL" -d /tmp/bin-extract/ 2>/dev/null
          else
            python3 -c "import zipfile; zipfile.ZipFile('$TMP_DL').extractall('/tmp/bin-extract/')" 2>/dev/null
          fi
          # Copy any executables found
          find /tmp/bin-extract/ -type f -executable -exec cp {} "$PERSIST_BIN/" \;
          # Also make common binaries executable even if flag not set
          find /tmp/bin-extract/ -type f -name "nuclei" -o -name "httpx" -o -name "subfinder" | while read f; do
            chmod +x "$f"
            cp "$f" "$PERSIST_BIN/"
          done
          rm -rf /tmp/bin-extract/ "$TMP_DL"
          echo "  Extracted archive: $fname"
          ;;
        *.tar.gz|*.tgz)
          mkdir -p /tmp/bin-extract/
          tar xzf "$TMP_DL" -C /tmp/bin-extract/ 2>/dev/null
          find /tmp/bin-extract/ -type f -executable -exec cp {} "$PERSIST_BIN/" \;
          rm -rf /tmp/bin-extract/ "$TMP_DL"
          echo "  Extracted archive: $fname"
          ;;
        *)
          cp "$TMP_DL" "$PERSIST_BIN/$fname"
          chmod +x "$PERSIST_BIN/$fname"
          rm -f "$TMP_DL"
          echo "  Installed: $fname"
          ;;
      esac
    else
      echo "  WARN: Failed to download $url"
    fi
  done < "$BINS_FILE"
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
