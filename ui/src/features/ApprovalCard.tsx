import { useEffect, useState } from 'react'

import type { PendingApproval } from '../lib/session'
import type { ApprovalDecision } from '../lib/types'

/**
 * The daemon denies by policy when its timeout elapses, so the countdown is
 * the real deadline, not a decoration. It is announced assertively because a
 * turn is blocked until the user answers.
 */
export function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval
  busy: boolean
  onDecide: (decision: ApprovalDecision) => void
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])

  const remaining = Math.max(0, approval.deadline - now)
  const seconds = Math.ceil(remaining / 1000)
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const expired = remaining <= 0

  return (
    <div className="approval" role="alertdialog" aria-live="assertive" aria-label="Tool approval required">
      <div className="head">
        <span>Approve</span>
        <span className="tool-name">{approval.toolName}</span>
        <span className="count">{expired ? 'denied by policy' : clock}</span>
      </div>
      <pre>{approval.argumentsSummary}</pre>
      <div className="actions">
        <button className="primary" disabled={busy || expired} onClick={() => onDecide('allow_once')}>
          Allow once<kbd>↵</kbd>
        </button>
        <button disabled={busy || expired} onClick={() => onDecide('allow_always')}>
          Always allow<kbd>A</kbd>
        </button>
        <button disabled={busy || expired} onClick={() => onDecide('reject')}>
          Reject<kbd>R</kbd>
        </button>
      </div>
      {expired && (
        <p style={{ margin: '8px 0 0', fontSize: 12 }}>
          The daemon timed this request out and denied it. Ask again to retry.
        </p>
      )}
    </div>
  )
}
