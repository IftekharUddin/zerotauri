import type { SessionSummary } from '../lib/types'

const shortPath = (path: string | null): string => {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

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
  onOpen,
  onNew,
}: {
  sessions: SessionSummary[]
  activeId: string | null
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
              {session.name ?? shortPath(session.workspaceDir) ?? session.sessionId.slice(0, 8)}
            </span>
            <span className="meta">
              {session.agentAlias ?? 'agent'} · {session.messageCount} msg ·{' '}
              {relativeTime(session.lastActivity)}
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
