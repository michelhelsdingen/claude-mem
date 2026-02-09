#!/bin/bash
set -euo pipefail

# Claude-mem Update Script
# Pulls upstream changes, merges, and deploys.
# Aborts cleanly on merge conflicts without affecting running worker.

REPO_DIR="$HOME/Documents/claude-mem"
LOG_DIR="$HOME/.claude-mem/logs"
LOG="$LOG_DIR/deploy.log"

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

die() { log "ERROR: $*"; exit 1; }

cd "$REPO_DIR" || die "Cannot cd to $REPO_DIR"

log "=== UPDATE START ==="

# --- Check for uncommitted changes ---
if ! git diff --quiet || ! git diff --cached --quiet; then
    log "Stashing uncommitted changes..."
    git stash --include-untracked || die "Failed to stash changes"
    STASHED=true
else
    STASHED=false
fi

# --- Fetch upstream ---
log "Fetching upstream..."
git fetch upstream main || die "Failed to fetch upstream"

# --- Check if there are new changes ---
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse upstream/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    log "Already up to date with upstream/main"
    if [ "$STASHED" = true ]; then
        git stash pop 2>/dev/null || true
    fi
    log "=== UPDATE: NO CHANGES ==="
    exit 0
fi

# --- Show what's incoming ---
INCOMING=$(git log --oneline HEAD..upstream/main | wc -l | tr -d ' ')
log "Incoming: $INCOMING new commit(s) from upstream"
git log --oneline HEAD..upstream/main 2>&1 | tee -a "$LOG"

# --- Merge ---
log "Merging upstream/main..."
if ! git merge upstream/main --no-edit 2>&1 | tee -a "$LOG"; then
    log "Merge conflict detected, aborting merge"
    git merge --abort
    if [ "$STASHED" = true ]; then
        git stash pop 2>/dev/null || true
    fi
    die "Merge conflict - resolve manually: cd $REPO_DIR && git merge upstream/main"
fi

# --- Restore stashed changes ---
if [ "$STASHED" = true ]; then
    log "Restoring stashed changes..."
    if ! git stash pop 2>/dev/null; then
        log "WARNING: Stash pop had conflicts, check manually"
    fi
fi

log "Merge successful ($INCOMING commits)"

# --- Deploy ---
log "Triggering deploy..."
exec "$REPO_DIR/scripts/deploy.sh"
