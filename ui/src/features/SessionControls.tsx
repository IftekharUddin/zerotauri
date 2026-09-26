import { effectiveIdentity, type Caps } from '../lib/overrides'
import type { SessionState } from '../lib/session'

const isMac = navigator.platform.toLowerCase().includes('mac')
const key = (letter: string) => (isMac ? `⇧⌘${letter}` : `Ctrl+Shift+${letter}`)

/**
 * The per-session settings as pills in the composer row. Each opens a picker.
 * While a turn runs they stay clickable and explain why nothing changes,
 * which reads better than a control that silently does nothing.
 */
export function SessionControls({
  session,
  caps,
  locked,
  onProvider,
  onModel,
}: {
  session: SessionState
  caps: Caps
  locked: boolean
  onProvider: () => void
  onModel: () => void
}) {
  if (!caps.configure) return null
  const identity = effectiveIdentity(session)
  const muted = locked ? ' muted' : ''

  return (
    <div className="controls" role="group" aria-label="Session settings">
      {caps.providers && (
        <button
          type="button"
          className={`chip control${muted}`}
          onClick={onProvider}
          title={`Provider for this session. Change it with ${key('P')}.`}
        >
          <span className="label">provider</span>
          <span className="value">{identity.provider ?? 'default'}</span>
        </button>
      )}
      <button
        type="button"
        className={`chip control${muted}`}
        onClick={onModel}
        title={`Model for this session. Change it with ${key('M')}.`}
      >
        <span className="label">model</span>
        <span className="value">{identity.model ?? 'default'}</span>
      </button>
    </div>
  )
}
