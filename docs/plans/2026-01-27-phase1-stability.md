# Phase 1: Stability Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate process leaks, chroma crashes, and orphaned MCP servers so claude-mem runs indefinitely without external cleanup scripts.

**Architecture:** Fixes are applied to the existing worker-service architecture. We add a Chroma disable setting, parent heartbeat to MCP servers, subprocess pool limits, and stale session recovery. No architectural changes (that's Phase 2).

**Tech Stack:** TypeScript, Bun, Express, SQLite, MCP SDK

---

### Task 1: Add CLAUDE_MEM_CHROMA_DISABLED setting

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts:15-97`
- Modify: `src/services/sync/ChromaSync.ts:91-118`

**Step 1: Add setting to interface and defaults**

In `src/shared/SettingsDefaultsManager.ts`, add to the `SettingsDefaults` interface (after line ~52):

```typescript
CLAUDE_MEM_CHROMA_DISABLED: string;
```

Add to the `DEFAULTS` object (after line ~96):

```typescript
CLAUDE_MEM_CHROMA_DISABLED: 'false',
```

**Step 2: Wire setting into ChromaSync constructor**

In `src/services/sync/ChromaSync.ts`, modify the constructor (lines 91-105). Replace the platform-only disable check with:

```typescript
constructor(project: string) {
  this.project = project;
  this.VECTOR_DB_DIR = path.join(CLAUDE_MEM_DIR, 'vector-db');

  // Check both platform and user setting
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const chromaDisabled = settings.CLAUDE_MEM_CHROMA_DISABLED === 'true';

  if (process.platform === 'win32' || chromaDisabled) {
    this.disabled = true;
    if (chromaDisabled) {
      logger.info('CHROMA_SYNC', 'Chroma disabled via CLAUDE_MEM_CHROMA_DISABLED setting', { project });
    } else {
      logger.warn('CHROMA_SYNC', 'Chroma disabled on Windows...', { project });
    }
  }
}
```

**Step 3: Verify ensureConnection() respects disabled flag**

Confirm `ensureConnection()` (line 118) already returns early when `this.disabled` is true via `isDisabled()` check. It does — line 118-120 calls `isDisabled()` which returns the flag.

**Step 4: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`
Expected: Build succeeds without errors.

**Step 5: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts src/services/sync/ChromaSync.ts
git commit -m "feat: add CLAUDE_MEM_CHROMA_DISABLED setting to disable vector search"
```

---

### Task 2: Add parent heartbeat to MCP server

**Files:**
- Modify: `src/servers/mcp-server.ts:296-313`

**Step 1: Add heartbeat check in main()**

In `src/servers/mcp-server.ts`, add a parent process heartbeat after the server starts running (after line ~310, inside `main()`). Add this before `await transport.start()`:

```typescript
// Parent heartbeat: exit if parent process dies (prevents orphaned MCP servers)
const HEARTBEAT_INTERVAL_MS = 30_000;
const heartbeat = setInterval(() => {
  // On Unix, ppid becomes 1 (init) when parent dies
  // On macOS, ppid becomes 1 (launchd) when parent dies
  if (process.ppid === 1 || process.ppid === 0) {
    logger.info('SYSTEM', 'Parent process gone (ppid=1), exiting MCP server');
    clearInterval(heartbeat);
    cleanup().then(() => process.exit(0));
  }
}, HEARTBEAT_INTERVAL_MS);

// Ensure heartbeat doesn't prevent process exit
heartbeat.unref();
```

**Step 2: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/servers/mcp-server.ts
git commit -m "fix: add parent heartbeat to MCP server to prevent orphaned processes"
```

---

### Task 3: Improve Chroma subprocess lifecycle

**Files:**
- Modify: `src/services/sync/ChromaSync.ts:132-150`

**Step 1: Add timeout wrapper to chroma connection**

In `src/services/sync/ChromaSync.ts`, wrap the `client.connect()` call (line 160) with a timeout:

```typescript
// In ensureConnection(), replace the await this.client.connect(this.transport):
const CONNECT_TIMEOUT_MS = 30_000;
const connectPromise = this.client.connect(this.transport);
const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error('Chroma connection timeout after 30s')), CONNECT_TIMEOUT_MS)
);

try {
  await Promise.race([connectPromise, timeoutPromise]);
} catch (error) {
  // Kill the transport/subprocess on timeout
  logger.error('CHROMA_SYNC', 'Connection failed or timed out, cleaning up', { project: this.project }, error as Error);
  try { await this.transport?.close(); } catch {}
  this.transport = null;
  this.client = null;
  this.connected = false;
  throw error;
}
```

**Step 2: Add reconnect guard**

Add a flag to prevent concurrent reconnection attempts. At class level (after line ~78):

```typescript
private connecting = false;
```

At the start of `ensureConnection()` (line 118):

```typescript
if (this.connecting) {
  logger.debug('CHROMA_SYNC', 'Connection already in progress, waiting...', { project: this.project });
  // Wait for existing connection attempt
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (this.connected || !this.connecting) break;
  }
  if (this.connected) return;
  throw new Error('Concurrent connection attempt failed');
}
this.connecting = true;
try {
  // ... existing connection logic ...
} finally {
  this.connecting = false;
}
```

**Step 3: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add src/services/sync/ChromaSync.ts
git commit -m "fix: add connection timeout and reconnect guard to ChromaSync"
```

---

### Task 4: Add subprocess pool limit to worker

**Files:**
- Modify: `src/services/worker/SDKAgent.ts:42-118`
- Modify: `src/services/worker/ProcessRegistry.ts` (examine first)

**Step 1: Examine ProcessRegistry**

Read `src/services/worker/ProcessRegistry.ts` to understand current process tracking.

**Step 2: Add pool limit**

In `SDKAgent.ts`, add a concurrency check at the start of `startSession()` (line 42). Import ProcessRegistry and add:

```typescript
const MAX_CONCURRENT_AGENTS = 2;

// At start of startSession():
const activeCount = ProcessRegistry.getActiveCount();
if (activeCount >= MAX_CONCURRENT_AGENTS) {
  logger.warn('AGENT', `Pool limit reached (${activeCount}/${MAX_CONCURRENT_AGENTS}), waiting...`, {
    sessionDbId: session.sessionDbId
  });
  // Wait for a slot to free up (max 60s)
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (ProcessRegistry.getActiveCount() < MAX_CONCURRENT_AGENTS) break;
  }
  if (ProcessRegistry.getActiveCount() >= MAX_CONCURRENT_AGENTS) {
    throw new Error('Agent pool timeout: too many concurrent subprocesses');
  }
}
```

**Step 3: Add getActiveCount to ProcessRegistry if missing**

If `ProcessRegistry` doesn't have `getActiveCount()`, add it:

```typescript
static getActiveCount(): number {
  return this.registry.size;
}
```

**Step 4: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add src/services/worker/SDKAgent.ts src/services/worker/ProcessRegistry.ts
git commit -m "fix: add subprocess pool limit (max 2 concurrent agents)"
```

---

### Task 5: Add stale session recovery on worker start

**Files:**
- Modify: `src/services/worker-service.ts:251-338`

**Step 1: Add stale session cleanup in initializeBackground()**

In `src/services/worker-service.ts`, after the orphan process cleanup (line 253) and before settings loading (line 260), add:

```typescript
// Recover stale sessions from previous crash
try {
  const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  const db = this.dbManager.getDatabase();
  const now = Date.now();
  const cutoff = new Date(now - STALE_THRESHOLD_MS).toISOString();

  const staleCount = db.prepare(`
    UPDATE sessions
    SET status = 'failed', ended_at = ?
    WHERE status = 'active' AND started_at < ?
  `).run(new Date().toISOString(), cutoff);

  if (staleCount.changes > 0) {
    logger.info('SYSTEM', `Recovered ${staleCount.changes} stale sessions from previous crash`, {
      threshold: '10 minutes'
    });
  }
} catch (error) {
  logger.warn('SYSTEM', 'Failed to recover stale sessions', {}, error as Error);
}
```

**Step 2: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/services/worker-service.ts
git commit -m "fix: recover stale active sessions on worker startup"
```

---

### Task 6: Enhance orphan cleanup to cover MCP servers

**Files:**
- Modify: `src/services/infrastructure/ProcessManager.ts:168-260`

**Step 1: Extend cleanupOrphanedProcesses() for MCP servers**

In `ProcessManager.ts`, the current `cleanupOrphanedProcesses()` only targets chroma-mcp (line ~198). Extend it to also find orphaned mcp-server.cjs processes.

After the existing chroma cleanup block (after line ~260), add:

```typescript
// Also cleanup orphaned MCP server processes (ppid=1, older than 5 min)
try {
  if (process.platform !== 'win32') {
    const mcpResult = execSync(
      `ps -eo pid,ppid,etimes,command | grep 'mcp-server.cjs' | grep -v grep`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (mcpResult) {
      const mcpOrphans: number[] = [];
      for (const line of mcpResult.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0]);
        const ppid = parseInt(parts[1]);
        const elapsedSeconds = parseInt(parts[2]);
        // Kill if orphaned (ppid=1) and older than 5 minutes
        if (ppid === 1 && elapsedSeconds > 300 && !isNaN(pid)) {
          mcpOrphans.push(pid);
        }
      }
      if (mcpOrphans.length > 0) {
        logger.info('SYSTEM', `Found ${mcpOrphans.length} orphaned MCP server processes`, {
          pids: mcpOrphans
        });
        for (const pid of mcpOrphans) {
          await forceKillProcess(pid);
        }
      }
    }
  }
} catch {
  // No orphaned MCP servers found, or ps command failed
}
```

**Step 2: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/services/infrastructure/ProcessManager.ts
git commit -m "fix: extend orphan cleanup to cover MCP server processes"
```

---

### Task 7: Add internal chroma watchdog to worker

**Files:**
- Modify: `src/services/worker-service.ts:313-320`

**Step 1: Enhance the existing orphan reaper with chroma health check**

The worker already has `startOrphanReaper()` (line 313). We need to also check chroma health. In `initializeBackground()`, after the orphan reaper setup, add a chroma watchdog:

```typescript
// Chroma watchdog: check if chroma-mcp is responsive, restart if dead
if (!settings.CLAUDE_MEM_CHROMA_DISABLED || settings.CLAUDE_MEM_CHROMA_DISABLED !== 'true') {
  const CHROMA_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const chromaWatchdog = setInterval(async () => {
    try {
      const chromaSync = this.dbManager.getChromaSync();
      if (chromaSync && chromaSync.isDisabled()) return;
      if (!chromaSync || !chromaSync.isConnected()) {
        logger.warn('SYSTEM', 'Chroma watchdog: connection lost, attempting reconnect');
        try {
          await chromaSync?.close();
        } catch {}
        // ChromaSync will reconnect on next use via ensureConnection()
      }
    } catch (error) {
      logger.error('SYSTEM', 'Chroma watchdog error', {}, error as Error);
    }
  }, CHROMA_CHECK_INTERVAL_MS);
  chromaWatchdog.unref();
}
```

**Step 2: Add isConnected() to ChromaSync if missing**

In `src/services/sync/ChromaSync.ts`, add after `isDisabled()`:

```typescript
isConnected(): boolean {
  return this.connected;
}
```

**Step 3: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add src/services/worker-service.ts src/services/sync/ChromaSync.ts
git commit -m "feat: add internal chroma watchdog to worker service"
```

---

### Task 8: Deploy, test, and clean up old infrastructure

**Step 1: Deploy all changes**

Run: `~/Documents/claude-mem/scripts/deploy.sh`
Expected: Build + sync + restart succeeds, health check passes.

**Step 2: Enable chroma disable setting (optional but recommended)**

```bash
# Edit settings to disable chroma for now (biggest stability win)
cat ~/.claude-mem/settings.json | python3 -c "
import json, sys
s = json.load(sys.stdin)
s['CLAUDE_MEM_CHROMA_DISABLED'] = 'true'
json.dump(s, sys.stdout, indent=2)
" > /tmp/settings.json && mv /tmp/settings.json ~/.claude-mem/settings.json
```

Then restart worker: `~/Documents/claude-mem/scripts/deploy.sh`

**Step 3: Verify memory search still works**

Start a new Claude Code session and verify:
- Context injection works (observations appear in session start)
- Memory search works (search tool returns results)
- No chroma processes are running (if disabled)

**Step 4: Monitor for 1 hour**

```bash
# Check process count periodically
watch -n 30 'ps aux | grep -E "claude-mem|chroma|mcp-server" | grep -v grep | wc -l'
```

**Step 5: Remove old cleanup infrastructure (after confirming stability)**

```bash
# Unload old cleanup LaunchAgents
launchctl unload ~/Library/LaunchAgents/com.claude-mem.orphan-reaper.plist
launchctl unload ~/Library/LaunchAgents/com.claude-mem.cleanup.plist

# Remove files
rm ~/Library/LaunchAgents/com.claude-mem.orphan-reaper.plist
rm ~/Library/LaunchAgents/com.claude-mem.cleanup.plist
rm ~/.claude/cleanup-claude-mem.sh
```

**Step 6: Commit cleanup**

```bash
git add -A
git commit -m "phase 1 complete: stability fixes deployed, old cleanup scripts removed"
```
