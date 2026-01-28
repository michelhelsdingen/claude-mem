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
        <span className={`status-dot ${sessionCount > 0 ? 'active' : 'inactive'}`} />
        <span className="status-label">{sessionCount} session{sessionCount !== 1 ? 's' : ''}</span>

        {showSessionsDropdown && sessions.length > 0 && (
          <div className="status-dropdown">
            <div className="dropdown-header">Active Sessions</div>
            {sessions.map(session => (
              <div key={session.sessionDbId} className="dropdown-item">
                <span className={`status-dot ${session.hasGenerator ? 'processing' : 'idle'}`} />
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
        <span className={`status-dot ${processCount > 0 ? 'processing' : 'inactive'}`} />
        <span className="status-label">{poolUsage} proc</span>

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
      <div className="status-actions">
        <button
          className={`status-action-btn ${confirmRestart ? 'confirm' : ''}`}
          onClick={handleRestart}
          title={confirmRestart ? 'Click again to confirm restart' : 'Restart Worker'}
        >
          {confirmRestart ? '?' : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
          )}
        </button>
        <button
          className={`status-action-btn ${confirmClear ? 'confirm' : ''}`}
          onClick={handleClearQueue}
          title={confirmClear ? 'Click again to confirm clear' : 'Clear Queue'}
        >
          {confirmClear ? '?' : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
