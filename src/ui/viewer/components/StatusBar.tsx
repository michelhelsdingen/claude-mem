import React, { useState } from 'react';
import { useSystemStatus } from '../hooks/useSystemStatus';

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function StatusBar() {
  const {
    sessions,
    sessionCount,
    processes,
    processCount,
    maxProcesses,
    poolUsage,
    restartWorker,
    clearQueue
  } = useSystemStatus();

  const [showSessionsDropdown, setShowSessionsDropdown] = useState(false);
  const [showProcessesDropdown, setShowProcessesDropdown] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const handleRestart = () => {
    if (confirmRestart) {
      restartWorker();
      setConfirmRestart(false);
    } else {
      setConfirmRestart(true);
      setTimeout(() => setConfirmRestart(false), 3000);
    }
  };

  const handleClearQueue = () => {
    if (confirmClear) {
      clearQueue();
      setConfirmClear(false);
    } else {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
    }
  };

  return (
    <div className="status-bar">
      {/* Sessions indicator */}
      <div
        className="status-item"
        onMouseEnter={() => setShowSessionsDropdown(true)}
        onMouseLeave={() => setShowSessionsDropdown(false)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: sessionCount > 0 ? '#22c55e' : '#6b7280' }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="status-label">{sessionCount}</span>

        {showSessionsDropdown && sessions.length > 0 && (
          <div className="status-dropdown">
            <div className="dropdown-header">Active Sessions</div>
            {sessions.map(session => (
              <div key={session.sessionDbId} className="dropdown-item">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: session.hasGenerator ? '#f59e0b' : '#6b7280' }}>
                  <circle cx="12" cy="12" r="10" />
                  {session.hasGenerator && <path d="M12 6v6l4 2" />}
                </svg>
                <span className="dropdown-project">{session.project}</span>
                <span className="dropdown-meta">
                  #{session.sessionDbId} ({formatAge(session.ageMs)})
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Processes indicator */}
      <div
        className="status-item"
        onMouseEnter={() => setShowProcessesDropdown(true)}
        onMouseLeave={() => setShowProcessesDropdown(false)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: processCount > 0 ? '#f59e0b' : '#6b7280' }}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <path d="M9 1v3" /><path d="M15 1v3" />
          <path d="M9 20v3" /><path d="M15 20v3" />
          <path d="M20 9h3" /><path d="M20 14h3" />
          <path d="M1 9h3" /><path d="M1 14h3" />
        </svg>
        <span className="status-label">{poolUsage}</span>

        {showProcessesDropdown && processes.length > 0 && (
          <div className="status-dropdown">
            <div className="dropdown-header">Claude Subprocesses</div>
            {processes.map(proc => (
              <div key={proc.pid} className="dropdown-item">
                <span className="dropdown-pid">PID {proc.pid}</span>
                <span className="dropdown-meta">
                  session #{proc.sessionDbId} ({formatAge(proc.ageMs)})
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="status-actions" style={{ display: 'flex', gap: '4px' }}>
        <button
          onClick={handleRestart}
          title={confirmRestart ? 'Click again to confirm' : 'Restart Worker'}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            border: '1px solid #444',
            borderRadius: '4px',
            background: confirmRestart ? '#3b82f6' : '#2a2a2a',
            color: confirmRestart ? 'white' : '#9ca3af',
            cursor: 'pointer'
          }}
        >
          {confirmRestart ? 'OK?' : 'Restart'}
        </button>
        <button
          onClick={handleClearQueue}
          title={confirmClear ? 'Click again to confirm' : 'Clear Queue'}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            border: '1px solid #444',
            borderRadius: '4px',
            background: confirmClear ? '#ef4444' : '#2a2a2a',
            color: confirmClear ? 'white' : '#9ca3af',
            cursor: 'pointer'
          }}
        >
          {confirmClear ? 'OK?' : 'Clear'}
        </button>
      </div>
    </div>
  );
}
