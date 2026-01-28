import { useState, useEffect, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';

interface ActiveSession {
  sessionDbId: number;
  project: string;
  startTime: number;
  ageMs: number;
  queueDepth: number;
  hasGenerator: boolean;
  currentProvider: string | null;
}

interface Process {
  pid: number;
  sessionDbId: number;
  ageMs: number;
}

interface SystemStatus {
  sessions: ActiveSession[];
  sessionCount: number;
  processes: Process[];
  processCount: number;
  maxProcesses: number;
  poolUsage: string;
}

const POLL_INTERVAL = 2000; // Poll every 2 seconds

export function useSystemStatus() {
  const [status, setStatus] = useState<SystemStatus>({
    sessions: [],
    sessionCount: 0,
    processes: [],
    processCount: 0,
    maxProcesses: 2,
    poolUsage: '0/2'
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const [sessionsRes, processesRes] = await Promise.all([
        fetch(API_ENDPOINTS.SESSIONS_ACTIVE),
        fetch(API_ENDPOINTS.PROCESSES)
      ]);

      const sessionsData = await sessionsRes.json();
      const processesData = await processesRes.json();

      setStatus({
        sessions: sessionsData.sessions || [],
        sessionCount: sessionsData.count || 0,
        processes: processesData.processes || [],
        processCount: processesData.activeCount || 0,
        maxProcesses: processesData.maxConcurrent || 2,
        poolUsage: processesData.poolUsage || '0/2'
      });
      setIsLoading(false);
    } catch (error) {
      console.error('Failed to fetch system status:', error);
    }
  }, []);

  const restartWorker = useCallback(async () => {
    try {
      await fetch(API_ENDPOINTS.WORKER_RESTART, { method: 'POST' });
      // Worker will restart, connection will be lost temporarily
    } catch (error) {
      console.error('Failed to restart worker:', error);
    }
  }, []);

  const clearQueue = useCallback(async () => {
    try {
      await fetch(API_ENDPOINTS.QUEUE_CLEAR, { method: 'DELETE' });
      // Refresh status after clearing
      await fetchStatus();
    } catch (error) {
      console.error('Failed to clear queue:', error);
    }
  }, [fetchStatus]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return {
    ...status,
    isLoading,
    restartWorker,
    clearQueue,
    refresh: fetchStatus
  };
}
