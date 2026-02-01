/**
 * ProcessRegistry: Track spawned Claude subprocesses
 *
 * Fixes Issue #737: Claude haiku subprocesses don't terminate properly,
 * causing zombie process accumulation (user reported 155 processes / 51GB RAM).
 *
 * Root causes:
 * 1. SDK's SpawnedProcess interface hides subprocess PIDs
 * 2. deleteSession() doesn't verify subprocess exit before cleanup
 * 3. abort() is fire-and-forget with no confirmation
 *
 * Solution:
 * - Use SDK's spawnClaudeCodeProcess option to capture PIDs
 * - Track all spawned processes with session association
 * - Verify exit on session deletion with timeout + SIGKILL escalation
 * - Safety net orphan reaper runs every 5 minutes
 * - Age-based killing: processes older than MAX_PROCESS_AGE_MS are killed (Issue #818)
 */

// Maximum age for a subprocess before it's considered stale and killed
// 5 minutes should be enough for any SDK query - if it takes longer, it's likely hung
const MAX_PROCESS_AGE_MS = 5 * 60 * 1000;

import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

interface TrackedProcess {
  pid: number;
  sessionDbId: number;
  spawnedAt: number;
  process: ChildProcess;
}

// PID Registry - tracks spawned Claude subprocesses
const processRegistry = new Map<number, TrackedProcess>();

/**
 * Register a spawned process in the registry
 */
export function registerProcess(pid: number, sessionDbId: number, process: ChildProcess): void {
  processRegistry.set(pid, { pid, sessionDbId, spawnedAt: Date.now(), process });
  logger.info('PROCESS', `Registered PID ${pid} for session ${sessionDbId}`, { pid, sessionDbId });
}

/**
 * Unregister a process from the registry
 */
export function unregisterProcess(pid: number): void {
  processRegistry.delete(pid);
  logger.debug('PROCESS', `Unregistered PID ${pid}`, { pid });
}

/**
 * Get process info by session ID
 * Warns if multiple processes found (indicates race condition)
 */
export function getProcessBySession(sessionDbId: number): TrackedProcess | undefined {
  const matches: TrackedProcess[] = [];
  for (const [, info] of processRegistry) {
    if (info.sessionDbId === sessionDbId) matches.push(info);
  }
  if (matches.length > 1) {
    logger.warn('PROCESS', `Multiple processes found for session ${sessionDbId}`, {
      count: matches.length,
      pids: matches.map(m => m.pid)
    });
  }
  return matches[0];
}

/**
 * Get the count of currently active (tracked) processes.
 * Cleans up dead processes before counting to prevent phantom pool exhaustion.
 */
export function getActiveCount(): number {
  for (const [pid, info] of processRegistry) {
    // Check ChildProcess state
    if (info.process.killed || info.process.exitCode !== null) {
      unregisterProcess(pid);
      continue;
    }
    // OS-level liveness check (signal 0 tests existence without killing)
    try {
      process.kill(pid, 0);
    } catch {
      logger.debug('PROCESS', `PID ${pid} no longer alive, cleaning up`, { pid, sessionDbId: info.sessionDbId });
      unregisterProcess(pid);
    }
  }
  return processRegistry.size;
}

/**
 * Get all active PIDs (for debugging)
 */
export function getActiveProcesses(): Array<{ pid: number; sessionDbId: number; ageMs: number }> {
  const now = Date.now();
  return Array.from(processRegistry.values()).map(info => ({
    pid: info.pid,
    sessionDbId: info.sessionDbId,
    ageMs: now - info.spawnedAt
  }));
}

/**
 * Wait for a process to exit with timeout, escalating to SIGKILL if needed
 * Uses event-based waiting instead of polling to avoid CPU overhead
 */
export async function ensureProcessExit(tracked: TrackedProcess, timeoutMs: number = 5000): Promise<void> {
  const { pid, process: proc } = tracked;

  // Already exited?
  if (proc.killed || proc.exitCode !== null) {
    unregisterProcess(pid);
    return;
  }

  // Wait for graceful exit with timeout using event-based approach
  const exitPromise = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  // Check if exited gracefully
  if (proc.killed || proc.exitCode !== null) {
    unregisterProcess(pid);
    return;
  }

  // Timeout: escalate to SIGKILL
  logger.warn('PROCESS', `PID ${pid} did not exit after ${timeoutMs}ms, sending SIGKILL`, { pid, timeoutMs });
  try {
    proc.kill('SIGKILL');
  } catch {
    // Already dead
  }

  // Brief wait for SIGKILL to take effect
  await new Promise(resolve => setTimeout(resolve, 200));
  unregisterProcess(pid);
}

/**
 * Kill system-level orphans (ppid=1 on Unix)
 * These are Claude processes whose parent died unexpectedly
 */
async function killSystemOrphans(): Promise<number> {
  if (process.platform === 'win32') {
    return 0; // Windows doesn't have ppid=1 orphan concept
  }

  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,args 2>/dev/null | grep -E "claude.*haiku|claude.*output-format" | grep -v grep'
    );

    let killed = 0;
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const match = line.trim().match(/^(\d+)\s+(\d+)/);
      if (match && parseInt(match[2]) === 1) { // ppid=1 = orphan
        const orphanPid = parseInt(match[1]);
        logger.warn('PROCESS', `Killing system orphan PID ${orphanPid}`, { pid: orphanPid });
        try {
          process.kill(orphanPid, 'SIGKILL');
          killed++;
        } catch {
          // Already dead or permission denied
        }
      }
    }
    return killed;
  } catch {
    return 0; // No matches or error
  }
}

/**
 * Reap orphaned processes - both registry-tracked and system-level
 * Also cleans up dead PIDs from registry to prevent phantom pool exhaustion
 *
 * Issue #818: Now also kills processes older than MAX_PROCESS_AGE_MS
 * This prevents hanging SDK calls from blocking the agent pool forever
 */
export async function reapOrphanedProcesses(activeSessionIds: Set<number>): Promise<number> {
  let killed = 0;
  let cleaned = 0;
  let agedOut = 0;
  const now = Date.now();

  // First pass: clean up dead PIDs from registry (liveness check)
  for (const [pid, info] of processRegistry) {
    // Check ChildProcess state
    if (info.process.killed || info.process.exitCode !== null) {
      logger.debug('PROCESS', `Reaper: PID ${pid} already exited, cleaning registry`, { pid, sessionDbId: info.sessionDbId });
      unregisterProcess(pid);
      cleaned++;
      continue;
    }
    // OS-level liveness check (signal 0 tests existence without killing)
    try {
      process.kill(pid, 0);
    } catch {
      logger.debug('PROCESS', `Reaper: PID ${pid} no longer alive, cleaning registry`, { pid, sessionDbId: info.sessionDbId });
      unregisterProcess(pid);
      cleaned++;
    }
  }

  // Second pass: kill processes for dead sessions OR processes that are too old
  for (const [pid, info] of processRegistry) {
    const processAge = now - info.spawnedAt;
    const isTooOld = processAge > MAX_PROCESS_AGE_MS;
    const isOrphaned = !activeSessionIds.has(info.sessionDbId);

    if (!isTooOld && !isOrphaned) continue; // Active and young = safe

    if (isTooOld) {
      const ageMinutes = Math.round(processAge / 60000);
      logger.warn('PROCESS', `Killing stale PID ${pid} (age: ${ageMinutes}m, session ${info.sessionDbId})`, {
        pid,
        sessionDbId: info.sessionDbId,
        ageMs: processAge,
        reason: 'exceeded_max_age'
      });
      agedOut++;
    } else {
      logger.warn('PROCESS', `Killing orphan PID ${pid} (session ${info.sessionDbId} gone)`, { pid, sessionDbId: info.sessionDbId });
    }

    try {
      info.process.kill('SIGKILL');
      killed++;
    } catch {
      // Already dead
    }
    unregisterProcess(pid);
  }

  // System-level: find ppid=1 orphans
  killed += await killSystemOrphans();

  if (cleaned > 0) {
    logger.info('PROCESS', `Reaper cleaned ${cleaned} stale registry entries`, { cleaned });
  }

  if (agedOut > 0) {
    logger.info('PROCESS', `Reaper killed ${agedOut} processes exceeding max age (${MAX_PROCESS_AGE_MS / 60000}m)`, { agedOut });
  }

  return killed;
}

/**
 * Create a custom spawn function for SDK that captures PIDs
 *
 * The SDK's spawnClaudeCodeProcess option allows us to intercept subprocess
 * creation and capture the PID before the SDK hides it.
 *
 * NOTE: Session isolation is handled via the `cwd` option in SDKAgent.ts,
 * NOT via CLAUDE_CONFIG_DIR (which breaks authentication).
 */
export function createPidCapturingSpawn(sessionDbId: number) {
  return (spawnOptions: {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }) => {
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: spawnOptions.signal, // CRITICAL: Pass signal for AbortController integration
      windowsHide: true
    });

    // Register PID
    if (child.pid) {
      registerProcess(child.pid, sessionDbId, child);

      // Auto-unregister on exit
      child.on('exit', () => {
        if (child.pid) {
          unregisterProcess(child.pid);
        }
      });
    }

    // Return SDK-compatible interface
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: child.kill.bind(child),
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child)
    };
  };
}

/**
 * Start the orphan reaper interval
 * Returns cleanup function to stop the interval
 *
 * Issue #818: Now runs every 60 seconds instead of 5 minutes for faster cleanup
 */
export function startOrphanReaper(getActiveSessionIds: () => Set<number>, intervalMs: number = 60 * 1000): () => void {
  const interval = setInterval(async () => {
    try {
      const activeIds = getActiveSessionIds();
      const killed = await reapOrphanedProcesses(activeIds);
      if (killed > 0) {
        logger.info('PROCESS', `Reaper cleaned up ${killed} orphaned processes`, { killed });
      }
    } catch (error) {
      logger.error('PROCESS', 'Reaper error', {}, error as Error);
    }
  }, intervalMs);

  // Return cleanup function
  return () => clearInterval(interval);
}

/**
 * Force cleanup of old processes - called when pool is full
 * Returns number of processes killed
 */
export async function forceCleanupOldProcesses(): Promise<number> {
  let killed = 0;
  const now = Date.now();
  // More aggressive: kill anything older than 2 minutes when pool is full
  const AGGRESSIVE_MAX_AGE_MS = 2 * 60 * 1000;

  for (const [pid, info] of processRegistry) {
    const processAge = now - info.spawnedAt;
    if (processAge > AGGRESSIVE_MAX_AGE_MS) {
      const ageMinutes = Math.round(processAge / 60000);
      logger.warn('PROCESS', `Force-killing old PID ${pid} to free pool (age: ${ageMinutes}m)`, {
        pid,
        sessionDbId: info.sessionDbId,
        ageMs: processAge,
        reason: 'pool_full_cleanup'
      });

      try {
        info.process.kill('SIGKILL');
        killed++;
      } catch {
        // Already dead
      }
      unregisterProcess(pid);
    }
  }

  return killed;
}
