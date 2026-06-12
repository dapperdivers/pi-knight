#!/bin/bash
# nix-builder.sh — persistent shared-store builder (the nix-daemon builder).
#
# Runs as PID 1 in the roundtable-nix-builder Deployment: a single replica,
# root, the SOLE writer to the shared Nix store. It starts a nix-daemon and
# processes a file-based work queue that the operator writes build requests
# into. Builds run as concurrent `nix build` clients against the local daemon,
# which serializes store writes correctly and dedups shared derivations —
# replacing the old per-knight Job + global flock model. The result: no global
# lock, no per-pod re-bootstrap, and fleet rebuilds run in parallel instead of
# one knight at a time.
#
# Mounts:
#   /nix    → shared Nix store PVC (RW; this pod is the only writer)
#   /queue  → build-queue PVC (RWX; operator writes requests, builder writes results)
#
# Queue protocol (all paths under $BUILD_QUEUE_DIR, default /queue), keyed by
# "<knight>__<toolsHash>" so a request for a superseded hash is simply never
# claimed:
#   requests/<key>/flake.nix   — the knight's flake          (operator writes)
#   requests/<key>/ready       — completion marker, written last, atomically
#                                (operator writes; builder removes once built)
#   state/<key>                — builder's in-flight claim (atomic mkdir)
#   results/<key>.ok           — success: "<store-path> <tool-count>"
#   results/<key>.err          — failure: tail of the build log
# The operator keys readiness on results/<key>.ok and cleans up the request +
# result once it records status.nixToolsHash.
set -eo pipefail

QUEUE="${BUILD_QUEUE_DIR:-/queue}"
PROFILE_DIR="/nix/var/nix/profiles/knights"
MAX_CONCURRENCY="${NIX_BUILD_CONCURRENCY:-6}"
POLL_INTERVAL="${NIX_BUILD_POLL_SECONDS:-5}"

log() { echo "[nix-builder] $(date '+%H:%M:%S') $*"; }

# shellcheck source=/dev/null
. "$(dirname "$0")/nix-lib.sh"

if [ ! -w /nix ]; then
  log "FATAL: /nix is not writable — the builder must mount the store RW"
  exit 1
fi
mkdir -p /nix/var "$PROFILE_DIR" \
         "$QUEUE/requests" "$QUEUE/state" "$QUEUE/results"
# The queue is a private coordination channel between exactly two trusted pods —
# this builder (root) and the operator (non-root). The builder mounts the store
# PVC without fsGroup (to avoid a recursive chown of the 30Gi store on mount),
# so the two pods don't share a gid; make the coordination dirs world-writable
# so the operator can drop requests and reap results regardless of uid.
chmod 0777 "$QUEUE/requests" "$QUEUE/state" "$QUEUE/results" 2>/dev/null || true

# Stale claims can only come from a previous builder that died mid-build (this
# is the single writer, so no live builder shares the queue). Clear them so the
# operator's re-armed requests get picked up again.
rm -rf "${QUEUE:?}/state"/* 2>/dev/null || true

# One-time store bootstrap. Cheap on an already-bootstrapped store (relinks the
# profile); only the very first builder pays the full install.
rt_bootstrap_nix || { log "FATAL: Nix bootstrap failed"; exit 1; }
rt_restore_profile
rt_source_nix || { log "FATAL: nix not on PATH after bootstrap"; exit 1; }
log "Nix $(nix --version 2>/dev/null)"

# ── Start the daemon; clients reach it via NIX_REMOTE=daemon ──
log "Starting nix-daemon..."
nix-daemon >/tmp/nix-daemon.log 2>&1 &
DAEMON_PID=$!
export NIX_REMOTE=daemon
for _ in $(seq 1 30); do
  [ -S /nix/var/nix/daemon-socket/socket ] && break
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    log "FATAL: nix-daemon exited during startup:"; tail -20 /tmp/nix-daemon.log
    exit 1
  fi
  sleep 0.5
done
log "nix-daemon ready (pid $DAEMON_PID)"

TERM=0
shutdown() { log "Signal received — draining in-flight builds"; TERM=1; }
trap shutdown TERM INT

# build_one <key> — build one request's flake and publish its knight profile.
# Writes results/<key>.ok or .err, then clears the request's ready marker and
# its claim. Runs as a background worker; never aborts the supervisor.
build_one() {
  local key="$1"
  local reqdir="$QUEUE/requests/$key"
  local knight="${key%%__*}"
  local profile="$PROFILE_DIR/$knight"
  local work out n
  work=$(mktemp -d)
  cp "$reqdir/flake.nix" "$work/flake.nix" 2>/dev/null || {
    echo "request missing flake.nix" > "$QUEUE/results/$key.err"
    rm -rf "$work" "$QUEUE/state/$key"; rm -f "$reqdir/ready"; return 0
  }

  if out=$(cd "$work" && nix build ".#default" --no-link --print-out-paths 2>&1); then
    out=$(echo "$out" | tail -1)
    if [ -d "$out/bin" ]; then
      # Publish the profile via an atomic symlink swap; profiles are GC roots.
      ln -sfn "$out" "$profile.tmp.$$" && mv -fT "$profile.tmp.$$" "$profile"
      n=$(find "$out/bin" -mindepth 1 -maxdepth 1 | wc -l)
      printf '%s %s\n' "$out" "$n" > "$QUEUE/results/$key.ok.tmp"
      mv -fT "$QUEUE/results/$key.ok.tmp" "$QUEUE/results/$key.ok"
      rm -f "$QUEUE/results/$key.err"
      log "OK   $knight → $out ($n tools)"
    else
      echo "build produced no bin/ at $out" > "$QUEUE/results/$key.err"
      log "ERR  $knight: build produced no bin/"
    fi
  else
    { echo "nix build failed:"; echo "$out" | tail -25; } > "$QUEUE/results/$key.err.tmp"
    mv -fT "$QUEUE/results/$key.err.tmp" "$QUEUE/results/$key.err"
    log "ERR  $knight: nix build failed (see results/$key.err)"
  fi

  rm -rf "$work"
  rm -f "$reqdir/ready"        # consumed — won't reprocess unless operator re-arms
  rm -rf "$QUEUE/state/$key"   # release the claim
}

log "Watching $QUEUE/requests (max concurrency $MAX_CONCURRENCY, poll ${POLL_INTERVAL}s)"
while [ "$TERM" -eq 0 ]; do
  shopt -s nullglob
  for reqdir in "$QUEUE"/requests/*/; do
    [ -e "${reqdir}ready" ] || continue
    key=$(basename "$reqdir")
    [ -e "$QUEUE/results/$key.ok" ] && continue   # already built, awaiting operator cleanup
    # Atomic claim: mkdir succeeds for exactly one worker.
    if mkdir "$QUEUE/state/$key" 2>/dev/null; then
      while [ "$(jobs -rp | wc -l)" -ge "$MAX_CONCURRENCY" ]; do wait -n; done
      build_one "$key" &
    fi
  done
  shopt -u nullglob
  sleep "$POLL_INTERVAL"
done

log "Draining $(jobs -rp | wc -l) in-flight build(s)..."
wait
kill "$DAEMON_PID" 2>/dev/null || true
log "Builder stopped"
