import { changeFromTool, type FileChange } from '../lib/diff'
import type { SessionState } from '../lib/session'

interface TurnChanges {
  turn: number
  changes: FileChange[]
}

/** Group file-mutating tool calls by the turn that produced them. */
export function collectChanges(session: SessionState): TurnChanges[] {
  const byTurn = new Map<number, FileChange[]>()
  for (const entry of session.entries) {
    if (entry.kind !== 'tool') continue
    const change = changeFromTool({ name: entry.name, input: entry.input })
    if (!change) continue
    const bucket = byTurn.get(entry.turn) ?? []
    bucket.push(change)
    byTurn.set(entry.turn, bucket)
  }
  return [...byTurn.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([turn, changes]) => ({ turn, changes }))
}

function FileDiff({ change, open }: { change: FileChange; open: boolean }) {
  return (
    <details className="file" open={open}>
      <summary>
        <span className="path" title={change.path}>
          {change.path}
        </span>
        <span className="stat">
          <span className="plus">+{change.added}</span>{' '}
          <span className="minus">-{change.removed}</span>
        </span>
      </summary>
      <div className="diff">
        {change.lines.map((line, i) => (
          <div className={`line ${line.tag}`} key={i}>
            {line.tag === 'add' ? '+' : line.tag === 'remove' ? '-' : ' '}
            {line.text}
          </div>
        ))}
        {change.truncated && <div className="line context">… truncated</div>}
      </div>
    </details>
  )
}

export function ChangesPanel({ session }: { session: SessionState }) {
  const groups = collectChanges(session)
  const total = groups.reduce((sum, g) => sum + g.changes.length, 0)

  return (
    <aside className="changes" aria-label="Changes">
      <h2>Changes</h2>
      <div className="list">
        {total === 0 && (
          <p style={{ color: 'var(--zc-text-faint)', fontSize: 13, padding: '4px 2px' }}>
            File edits the agent makes will appear here, grouped by turn.
          </p>
        )}
        {groups.map((group, groupIndex) => (
          <div key={group.turn}>
            <div className="turn-label">
              {groupIndex === 0 ? 'This turn' : `Turn ${group.turn}`}
            </div>
            {group.changes.map((change, i) => (
              <FileDiff
                key={`${group.turn}-${change.path}-${i}`}
                change={change}
                open={groupIndex === 0}
              />
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}
