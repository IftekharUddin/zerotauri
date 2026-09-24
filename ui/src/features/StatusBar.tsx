import { phaseLabel, type SessionState } from '../lib/session'
import type { ConnectionInfo } from '../lib/types'

const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

export function StatusBar({
  info,
  connected,
  session,
}: {
  info: ConnectionInfo | null
  connected: boolean
  session: SessionState | null
}) {
  const busy = session ? session.phase !== 'idle' : false
  const pct =
    session && session.contextInput && session.contextMax
      ? Math.min(100, Math.round((session.contextInput / session.contextMax) * 100))
      : null

  return (
    <footer className="statusbar">
      <span
        className={`dot ${!connected ? 'off' : busy ? 'busy' : 'ok'}`}
        aria-hidden="true"
      />
      <span className="mono" title={info?.endpoint ?? ''}>
        {info ? info.endpoint.replace(/^.*\/(?=[^/]*\/[^/]*$)/, '…/') : 'not connected'}
      </span>
      {info?.startedByApp && <span>started by this app</span>}
      {info && <span>v{info.serverVersion}</span>}
      <span className="spacer" />
      {session && <span>{phaseLabel(session)}</span>}
      {session?.contextInput != null && (
        <span>
          ctx {compact(session.contextInput)}
          {session.contextMax ? ` / ${compact(session.contextMax)}` : ''}{' '}
          {pct !== null && (
            <span className="ctxbar" aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
          )}
        </span>
      )}
    </footer>
  )
}
