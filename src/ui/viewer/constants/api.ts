/**
 * API endpoint paths
 * Centralized to avoid magic strings scattered throughout the codebase
 */
export const API_ENDPOINTS = {
  BASE: '/api',
  OBSERVATIONS: '/api/observations',
  SUMMARIES: '/api/summaries',
  PROMPTS: '/api/prompts',
  SETTINGS: '/api/settings',
  STATS: '/api/stats',
  PROCESSING_STATUS: '/api/processing-status',
  STREAM: '/stream',
  // System status endpoints
  SESSIONS_ACTIVE: '/api/sessions/active',
  PROCESSES: '/api/processes',
  WORKER_RESTART: '/api/worker/restart',
  QUEUE_CLEAR: '/api/pending-queue/all',
} as const;
