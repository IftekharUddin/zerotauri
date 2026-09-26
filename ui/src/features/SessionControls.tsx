import { goalLabel } from '../lib/goal'
import { MODE_SUMMARY, type PlanSupport } from '../lib/modes'
import { effectiveIdentity, type Caps } from '../lib/overrides'
import type { SessionState } from '../lib/session'

const isMac = navigator.platform.toLowerCase().includes('mac')
const key = (letter: string) => (isMac ? `⇧⌘${letter}` : `Ctrl+Shift+${letter}`)

/**
 * The per-session settings as pills in the composer row. The mode pill cycles
 * modes; the others open a picker. While a turn runs they stay clickable and
 * explain why nothing changes, which reads better than a control that
 * silently does nothing.
 */
export function SessionControls({
  session,
  caps,
  planSupport,
  locked,
  onCycleMode,
  onProvider,
  onModel,
}: {
  session: SessionState
  caps: Caps
  planSupport: PlanSupport
  locked: boolean
  onCycleMode: () => void
  onProvider: () => void
  onModel: () => void
}) {
  const identity = effectiveIdentity(session)
  const muted = locked ? ' muted' : ''
  const planNote = planSupport === 'unsupported' ? ' This daemon does not enforce plan mode.' : ''

  return (
    <div className="controls" role="group" aria-label="Session settings">
      <button
        type="button"
        className={`chip control mode-${session.mode}${muted}`}
        onClick={onCycleMode}
        title={`${MODE_SUMMARY[session.mode]} Shift+Tab in the message box cycles modes.${planNote}`}
      >
        <span className="label">mode</span>
        <span className="value">{session.goal ? goalLabel(session.goal) : session.mode}</span>
      </button>
      {caps.configure && caps.providers && (
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
      {caps.configure && (
        <button
          type="button"
          className={`chip control${muted}`}
          onClick={onModel}
          title={`Model for this session. Change it with ${key('M')}.`}
        >
          <span className="label">model</span>
          <span className="value">{identity.model ?? 'default'}</span>
        </button>
      )}
    </div>
  )
}
