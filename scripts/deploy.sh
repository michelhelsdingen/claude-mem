#!/bin/bash
set -euo pipefail

# Claude-mem Deploy Script
# Builds from source, syncs to plugin cache, restarts worker.
# Safe: rolls back on failure, never touches ~/.claude-mem/ database.

REPO_DIR="$HOME/Documents/claude-mem"
CACHE_DIR="$HOME/.claude/plugins/cache/thedotmack/claude-mem/9.0.10"
ROLLBACK_DIR="/tmp/claude-mem-rollback"
LOG_DIR="$HOME/.claude-mem/logs"
LOG="$LOG_DIR/deploy.log"
WORKER_PORT=37777
HEALTH_TIMEOUT=30
PORT_TIMEOUT=10

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

die() { log "ERROR: $*"; exit 1; }

# --- Pre-flight ---
log "=== DEPLOY START ==="
log "Source: $REPO_DIR"
log "Target: $CACHE_DIR"

command -v bun >/dev/null 2>&1 || die "bun not found in PATH"
[ -d "$REPO_DIR/src" ] || die "Source directory not found: $REPO_DIR/src"
[ -f "$REPO_DIR/package.json" ] || die "package.json not found"

# --- Build ---
log "Building source..."
cd "$REPO_DIR"
if ! bun run build 2>&1 | tee -a "$LOG"; then
    die "Build failed, aborting (no changes made)"
fi
log "Build successful"

# --- Backup current cache ---
log "Backing up current cache to $ROLLBACK_DIR..."
rm -rf "$ROLLBACK_DIR"
if [ -d "$CACHE_DIR" ]; then
    cp -r "$CACHE_DIR" "$ROLLBACK_DIR"
    log "Backup created ($(du -sh "$ROLLBACK_DIR" | cut -f1))"
else
    log "No existing cache to backup"
fi

# --- Sync to cache ---
log "Syncing plugin/ to cache..."
mkdir -p "$CACHE_DIR"
rsync -a --delete "$REPO_DIR/plugin/" "$CACHE_DIR/"
log "Sync complete"

# --- Graceful worker shutdown ---
log "Stopping worker..."
if curl -sf -X POST "http://127.0.0.1:$WORKER_PORT/api/admin/shutdown" -m 5 >/dev/null 2>&1; then
    log "Graceful shutdown requested"
    sleep 2
else
    log "No worker responding, skipping graceful shutdown"
fi

# Force kill if still running
if lsof -ti:"$WORKER_PORT" >/dev/null 2>&1; then
    log "Force killing processes on port $WORKER_PORT"
    lsof -ti:"$WORKER_PORT" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# --- Wait for port free ---
log "Waiting for port $WORKER_PORT to free..."
for i in $(seq 1 "$PORT_TIMEOUT"); do
    if ! lsof -ti:"$WORKER_PORT" >/dev/null 2>&1; then
        log "Port $WORKER_PORT is free"
        break
    fi
    if [ "$i" -eq "$PORT_TIMEOUT" ]; then
        log "WARNING: Port still occupied after ${PORT_TIMEOUT}s, attempting rollback"
        # Rollback
        if [ -d "$ROLLBACK_DIR" ]; then
            cp -r "$ROLLBACK_DIR/" "$CACHE_DIR/"
            log "Cache rolled back"
        fi
        die "Port $WORKER_PORT did not free up"
    fi
    sleep 1
done

# --- Start worker daemon ---
log "Starting worker daemon..."
nohup bun "$CACHE_DIR/scripts/worker-service.cjs" --daemon >> "$LOG_DIR/worker-stdout.log" 2>> "$LOG_DIR/worker-stderr.log" &
WORKER_PID=$!
disown "$WORKER_PID"
log "Worker started (initial PID: $WORKER_PID)"

# --- Health check ---
log "Waiting for health (max ${HEALTH_TIMEOUT}s)..."
for i in $(seq 1 $((HEALTH_TIMEOUT / 2))); do
    if HEALTH=$(curl -sf "http://127.0.0.1:$WORKER_PORT/api/health" -m 2 2>/dev/null); then
        READINESS=$(curl -sf "http://127.0.0.1:$WORKER_PORT/api/readiness" -m 2 2>/dev/null || echo '{"status":"unknown"}')
        log "Worker healthy: $HEALTH"
        log "Readiness: $READINESS"
        log "=== DEPLOY SUCCESS ==="
        exit 0
    fi
    sleep 2
done

# --- Rollback on health failure ---
log "Worker failed to become healthy after ${HEALTH_TIMEOUT}s"
log "Rolling back..."

# Kill the unhealthy worker
lsof -ti:"$WORKER_PORT" | xargs kill -9 2>/dev/null || true
sleep 1

# Restore cache
if [ -d "$ROLLBACK_DIR" ]; then
    rm -rf "$CACHE_DIR"
    cp -r "$ROLLBACK_DIR" "$CACHE_DIR"
    log "Cache restored from rollback"

    # Start old worker
    nohup bun "$CACHE_DIR/scripts/worker-service.cjs" --daemon >> "$LOG_DIR/worker-stdout.log" 2>> "$LOG_DIR/worker-stderr.log" &
    disown $!
    sleep 5

    if curl -sf "http://127.0.0.1:$WORKER_PORT/api/health" -m 2 >/dev/null 2>&1; then
        log "Rollback worker is healthy"
    else
        log "WARNING: Rollback worker also failed to start"
    fi
fi

log "=== DEPLOY FAILED - ROLLED BACK ==="
exit 1
