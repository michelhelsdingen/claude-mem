# Remote Worker Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all hardcoded `127.0.0.1` references with the configurable `CLAUDE_MEM_WORKER_HOST` setting, so claude-mem clients on any device can connect to a remote worker via Tailscale.

**Architecture:** The worker already supports binding to any host via `CLAUDE_MEM_WORKER_HOST` and `CLAUDE_MEM_WORKER_PORT` settings. The MCP server already reads these settings. But 17+ CLI handler files hardcode `127.0.0.1` in fetch calls. We replace all hardcoded references with calls to `getWorkerHost()` / `getWorkerPort()`, which already exist in `worker-utils.ts`. We also add a `CLAUDE_MEM_REMOTE_MODE` setting that disables local worker auto-start when using a remote worker.

**Tech Stack:** TypeScript, Bun, Express, Tailscale

---

### Task 1: Replace hardcoded 127.0.0.1 in worker-utils.ts

**Files:**
- Modify: `src/shared/worker-utils.ts:60-90`

**Step 1: Fix isWorkerHealthy()**

In `src/shared/worker-utils.ts`, the `isWorkerHealthy()` function (line ~66) hardcodes `127.0.0.1`. Change it to use `getWorkerHost()`:

```typescript
// Before:
const response = await fetch(`http://127.0.0.1:${port}/api/readiness`, ...);

// After:
const host = getWorkerHost();
const response = await fetch(`http://${host}:${port}/api/readiness`, ...);
```

**Step 2: Fix getWorkerVersion()**

Same file, `getWorkerVersion()` (line ~85):

```typescript
// Before:
const response = await fetch(`http://127.0.0.1:${port}/api/version`, ...);

// After:
const host = getWorkerHost();
const response = await fetch(`http://${host}:${port}/api/version`, ...);
```

**Step 3: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`

**Step 4: Commit**

```bash
git add src/shared/worker-utils.ts
git commit -m "fix: use configurable host in worker-utils health checks"
```

---

### Task 2: Replace hardcoded 127.0.0.1 in HealthMonitor.ts

**Files:**
- Modify: `src/services/infrastructure/HealthMonitor.ts:23-111`

**Step 1: Add import for getWorkerHost**

At the top of the file, import `getWorkerHost`:

```typescript
import { getWorkerHost } from '../../shared/worker-utils.js';
```

**Step 2: Replace all 4 hardcoded references**

Replace all `127.0.0.1` in fetch calls with `getWorkerHost()`:

- Line ~23: `isPortInUse()` - `http://127.0.0.1:${port}/api/health`
- Line ~42: `waitForHealth()` - `http://127.0.0.1:${port}/api/readiness`
- Line ~74: `httpShutdown()` - `http://127.0.0.1:${port}/api/admin/shutdown`
- Line ~111: `getRunningWorkerVersion()` - `http://127.0.0.1:${port}/api/version`

For each, replace `127.0.0.1` with `${getWorkerHost()}`.

**Step 3: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`

**Step 4: Commit**

```bash
git add src/services/infrastructure/HealthMonitor.ts
git commit -m "fix: use configurable host in HealthMonitor"
```

---

### Task 3: Replace hardcoded 127.0.0.1 in CLI handlers

**Files:**
- Modify: `src/cli/handlers/session-init.ts:30,77`
- Modify: `src/cli/handlers/observation.ts:36`
- Modify: `src/cli/handlers/file-edit.ts:37`
- Modify: `src/cli/handlers/context.ts:23`
- Modify: `src/cli/handlers/summarize.ts:39`
- Modify: `src/cli/handlers/user-message.ts:24,41`

**Step 1: Add helper function to worker-utils.ts**

Add a convenience function to `src/shared/worker-utils.ts` that returns the base URL:

```typescript
export function getWorkerBaseUrl(): string {
  return `http://${getWorkerHost()}:${getWorkerPort()}`;
}
```

**Step 2: Update each CLI handler**

In each handler file, replace hardcoded URLs. The pattern for each file:

```typescript
// Before (in imports):
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';

// After:
import { ensureWorkerRunning, getWorkerBaseUrl } from '../../shared/worker-utils.js';

// Before (in fetch calls):
const port = getWorkerPort();
fetch(`http://127.0.0.1:${port}/api/sessions/init`, ...)

// After:
fetch(`${getWorkerBaseUrl()}/api/sessions/init`, ...)
```

Apply this pattern to all 7 handler files listed above. Each file has 1-2 fetch calls that need updating.

**Step 3: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`

**Step 4: Commit**

```bash
git add src/shared/worker-utils.ts src/cli/handlers/
git commit -m "fix: use configurable host in all CLI handlers"
```

---

### Task 4: Replace hardcoded 127.0.0.1 in CursorHooksInstaller

**Files:**
- Modify: `src/services/integrations/CursorHooksInstaller.ts:107,396,400`

**Step 1: Import getWorkerBaseUrl**

```typescript
import { getWorkerBaseUrl } from '../../shared/worker-utils.js';
```

**Step 2: Replace 3 hardcoded references**

Same pattern as Task 3 - replace `http://127.0.0.1:${port}` with `${getWorkerBaseUrl()}`.

**Step 3: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`

**Step 4: Commit**

```bash
git add src/services/integrations/CursorHooksInstaller.ts
git commit -m "fix: use configurable host in CursorHooksInstaller"
```

---

### Task 5: Add CLAUDE_MEM_REMOTE_MODE setting

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Modify: `src/shared/worker-utils.ts`

**Step 1: Add setting to interface and defaults**

In `src/shared/SettingsDefaultsManager.ts`, add to the `SettingsDefaults` interface:

```typescript
CLAUDE_MEM_REMOTE_MODE: string;
```

Add to the `DEFAULTS` object:

```typescript
CLAUDE_MEM_REMOTE_MODE: 'false',
```

**Step 2: Skip local worker spawn in remote mode**

In `src/shared/worker-utils.ts`, modify `ensureWorkerRunning()` to skip the auto-start logic when in remote mode. The function currently just polls - but other code may call `spawnDaemon()`. Add a check:

```typescript
export function isRemoteMode(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_REMOTE_MODE === 'true';
}
```

Then in any worker startup code (check `ProcessManager.ts` for `spawnDaemon` calls), add:

```typescript
if (isRemoteMode()) {
  logger.info('SYSTEM', 'Remote mode enabled, skipping local worker spawn');
  return; // Don't start local worker
}
```

**Step 3: Build and verify**

Run: `cd ~/Documents/claude-mem && bun run build`

**Step 4: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts src/shared/worker-utils.ts
git commit -m "feat: add CLAUDE_MEM_REMOTE_MODE to skip local worker spawn"
```

---

### Task 6: Expose worker via Tailscale on MacBook

**Step 1: Bind worker to all interfaces**

Edit `~/.claude-mem/settings.json` on MacBook:

```json
{
  "CLAUDE_MEM_WORKER_HOST": "0.0.0.0"
}
```

**Step 2: Set up Tailscale serve**

```bash
tailscale serve --bg --set-path /api --http 37777 http://localhost:37777
```

Or simpler - since Tailscale already makes port 37777 accessible to other Tailscale devices, we can just bind to `0.0.0.0` and access it via Tailscale IP directly.

**Step 3: Find MacBook's Tailscale IP**

```bash
tailscale ip -4
```

This gives the Tailscale IP (e.g., `100.x.y.z`) that other devices use.

**Step 4: Redeploy**

```bash
~/Documents/claude-mem/scripts/deploy.sh
```

**Step 5: Verify from VPS**

```bash
ssh plex "curl -sf http://<macbook-tailscale-ip>:37777/api/health"
```

---

### Task 7: Configure VPS plex as client

**Step 1: Stop local worker on VPS**

```bash
ssh plex "curl -sf -X POST http://127.0.0.1:37777/api/admin/shutdown -m 5 || true"
ssh plex "pkill -f worker-service || true"
```

**Step 2: Update VPS settings to point to MacBook**

```bash
ssh plex "cat > ~/.claude-mem/settings.json << 'SETTINGS'
{
  \"CLAUDE_MEM_MODEL\": \"claude-haiku-4-5\",
  \"CLAUDE_MEM_CONTEXT_OBSERVATIONS\": \"50\",
  \"CLAUDE_MEM_WORKER_PORT\": \"37777\",
  \"CLAUDE_MEM_WORKER_HOST\": \"<macbook-tailscale-ip>\",
  \"CLAUDE_MEM_REMOTE_MODE\": \"true\",
  \"CLAUDE_MEM_CHROMA_DISABLED\": \"true\",
  \"CLAUDE_MEM_SKIP_TOOLS\": \"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion\",
  \"CLAUDE_MEM_DATA_DIR\": \"/root/.claude-mem\",
  \"CLAUDE_MEM_LOG_LEVEL\": \"INFO\",
  \"CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS\": \"true\",
  \"CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS\": \"true\",
  \"CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT\": \"true\",
  \"CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT\": \"true\",
  \"CLAUDE_MEM_ENDLESS_MODE\": \"true\"
}
SETTINGS"
```

**Step 3: Deploy updated plugin on VPS**

The VPS also needs the updated plugin code with configurable host. Either:
- Copy our fork's built plugin to VPS, or
- Clone our fork on VPS and build there

```bash
# Option: rsync built plugin to VPS
rsync -avz ~/Documents/claude-mem/plugin/ plex:/mnt/docker/claude-mem/plugin/
```

**Step 4: Verify VPS can reach MacBook worker**

```bash
ssh plex "curl -sf http://<macbook-tailscale-ip>:37777/api/health"
```

Expected: `{"status":"ok",...}`

**Step 5: Test memory search from VPS**

Start a Claude Code session on VPS and verify memory observations appear.

---

### Task 8: Test end-to-end and backup VPS database

**Step 1: Backup VPS database before switch**

```bash
ssh plex "cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup-pre-remote-$(date +%Y%m%d)"
```

**Step 2: Copy VPS observations to MacBook DB (optional)**

If the VPS has unique observations not in the MacBook DB, consider merging them. This is a one-time migration.

**Step 3: Verify from multiple devices**

- MacBook: Start Claude Code, verify memory works
- VPS: Start Claude Code, verify it reads from MacBook worker
- Both should see the same observations

**Step 4: Commit all changes**

```bash
cd ~/Documents/claude-mem
git add -A
git commit -m "feat: remote worker access - all hardcoded 127.0.0.1 replaced with configurable host"
```
