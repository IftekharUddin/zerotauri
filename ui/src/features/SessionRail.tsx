import type { LiveMark } from '../lib/roster'
import type { SessionSummary } from '../lib/types'
import { sessionLabel } from '../lib/workspace'

const relativeTime = (iso: string): string => {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function SessionRail({
  sessions,
  activeId,
  marks,
  onOpen,
  onNew,
}: {
  sessions: SessionSummary[]
  activeId: string | null
  /** Sessions this window has open, with what they are doing right now. */
  marks: Map<string, LiveMark>
  onOpen: (session: SessionSummary) => void
  onNew: () => void
}) {
  return (
    <nav className="rail" aria-label="Sessions">
      <h2>Sessions</h2>
      <div className="list">
        {sessions.length === 0 && (
          <p style={{ color: 'var(--zc-text-faint)', fontSize: 12, padding: '2px 9px' }}>
            No saved sessions yet.
          </p>
        )}
        {sessions.map((session) => (
          <button
            type="button"
            className={`item${session.sessionId === activeId ? ' active' : ''}`}
            key={session.sessionId}
            onClick={() => onOpen(session)}
            aria-current={session.sessionId === activeId ? 'true' : undefined}
          >
            <span className="label">
              {session.name ?? sessionLabel(session.workspaceDir) ?? session.sessionId.slice(0, 8)}
            </span>
            <span className="meta">
              {session.agentAlias ?? 'agent'} · {session.messageCount} msg ·{' '}
              {relativeTime(session.lastActivity)}
              {marks.get(session.sessionId)?.approval ? (
                <span className="live approval"> · needs approval</span>
              ) : marks.get(session.sessionId)?.busy ? (
                <span className="live"> · running</span>
              ) : marks.has(session.sessionId) && session.sessionId !== activeId ? (
                <span className="live open"> · open</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
      <div className="foot">
        <button type="button" style={{ width: '100%' }} onClick={onNew}>
          New session
        </button>
      </div>
    </nav>
  )
}
