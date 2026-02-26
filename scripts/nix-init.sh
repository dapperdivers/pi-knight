#!/bin/sh
# nix-init.sh — Build knight tool environment from Nix flake
#
# Runs as an init container using nixos/nix image.
# Reads flake.nix from /config/ (ConfigMap), builds the tool closure,
# and copies the result to /data/nix-env/ on the shared PVC.
#
# The app container just needs /data/nix-env/bin on PATH.
# No Nix runtime required in the app container.

set -e

FLAKE_FILE="/config/flake.nix"
NIX_ENV="/data/nix-env"
HASH_FILE="/data/.nix-flake-hash"

if [ ! -f "$FLAKE_FILE" ]; then
  echo "No flake.nix found — skipping Nix tool install."
  # Fall back to legacy mise-init if present
  if [ -f "/config/apt.txt" ] || [ -f "/config/mise.toml" ]; then
    echo "Legacy config detected but no mise-init available in this container."
    echo "Configure flake.nix in ConfigMap to use Nix tooling."
  fi
  exit 0
fi

# Check if rebuild needed (content-addressed caching)
NEW_HASH=$(sha256sum "$FLAKE_FILE" | cut -d' ' -f1)
if [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE")" = "$NEW_HASH" ] && [ -d "$NIX_ENV/bin" ]; then
  TOOL_COUNT=$(ls "$NIX_ENV/bin/" 2>/dev/null | wc -l)
  echo "Nix environment cached (hash: ${NEW_HASH:0:12}..., $TOOL_COUNT tools) — skipping rebuild."
  ls "$NIX_ENV/bin/" 2>/dev/null | head -20
  exit 0
fi

echo "Building Nix tool environment..."
echo "  Flake hash: ${NEW_HASH:0:12}..."

# Set up flake directory
FLAKE_DIR=$(mktemp -d)
cp "$FLAKE_FILE" "$FLAKE_DIR/flake.nix"
[ -f "/config/flake.lock" ] && cp "/config/flake.lock" "$FLAKE_DIR/flake.lock"

# Enable flakes
export NIX_CONFIG="experimental-features = nix-command flakes
accept-flake-config = true"

# Build the tool environment
echo "  Running nix build (this may take a few minutes on first run)..."
STORE_PATH=$(nix build \
  --no-link \
  --print-out-paths \
  "path:${FLAKE_DIR}#default" 2>&1 | tail -1)

if [ ! -d "$STORE_PATH/bin" ]; then
  echo "ERROR: Nix build succeeded but no bin/ directory found at $STORE_PATH"
  echo "Contents: $(ls "$STORE_PATH" 2>/dev/null)"
  exit 1
fi

# Copy the closure to /data/nix-env (not a symlink — the Nix store
# is in the init container's filesystem, not on the PVC)
echo "  Copying tool closure to $NIX_ENV..."
rm -rf "$NIX_ENV"
mkdir -p "$NIX_ENV"

# Use nix-store --query to get the full closure, then copy everything
CLOSURE=$(nix-store --query --requisites "$STORE_PATH" 2>/dev/null || echo "$STORE_PATH")
CLOSURE_SIZE=$(echo "$CLOSURE" | wc -l)
echo "  Closure: $CLOSURE_SIZE store paths"

# Copy the bin/ directory and all required libraries
cp -a "$STORE_PATH/bin" "$NIX_ENV/bin"

# Copy shared libraries from the closure to lib/
mkdir -p "$NIX_ENV/lib"
for path in $CLOSURE; do
  if [ -d "$path/lib" ]; then
    cp -a "$path/lib/"*.so* "$NIX_ENV/lib/" 2>/dev/null || true
  fi
done

# Copy share/ data (nmap scripts, etc.)
if [ -d "$STORE_PATH/share" ]; then
  cp -a "$STORE_PATH/share" "$NIX_ENV/share"
fi
# Also grab share dirs from dependencies (nmap stores scripts in its own store path)
for path in $CLOSURE; do
  if [ -d "$path/share/nmap" ]; then
    mkdir -p "$NIX_ENV/share"
    cp -a "$path/share/nmap" "$NIX_ENV/share/nmap" 2>/dev/null || true
  fi
  # Perl modules
  if [ -d "$path/lib/perl5" ]; then
    mkdir -p "$NIX_ENV/lib/perl5"
    cp -a "$path/lib/perl5/"* "$NIX_ENV/lib/perl5/" 2>/dev/null || true
  fi
done

# Create wrapper script that sets LD_LIBRARY_PATH for each binary
# This ensures dynamically-linked binaries find their libs
WRAPPER_DIR="$NIX_ENV/.bin-unwrapped"
mkdir -p "$WRAPPER_DIR"
for bin in "$NIX_ENV/bin/"*; do
  bname=$(basename "$bin")
  if file "$bin" 2>/dev/null | grep -q "ELF"; then
    # It's a binary — wrap it
    mv "$bin" "$WRAPPER_DIR/$bname"
    cat > "$bin" << WRAP
#!/bin/sh
exec env LD_LIBRARY_PATH="$NIX_ENV/lib:\$LD_LIBRARY_PATH" "$WRAPPER_DIR/$bname" "\$@"
WRAP
    chmod +x "$bin"
  fi
done

# Save hash
echo "$NEW_HASH" > "$HASH_FILE"

TOOL_COUNT=$(ls "$NIX_ENV/bin/" 2>/dev/null | wc -l)
echo ""
echo "Nix environment ready: $TOOL_COUNT tools at $NIX_ENV/bin/"
ls "$NIX_ENV/bin/" 2>/dev/null | head -30
echo "Closure libs: $(ls "$NIX_ENV/lib/"*.so* 2>/dev/null | wc -l) shared libraries"
