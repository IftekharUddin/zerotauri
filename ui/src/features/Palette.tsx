import { useEffect, useMemo, useState } from 'react'

export interface Action {
  id: string
  label: string
  hint?: string
  run: () => void
  enabled?: boolean
}

/** Every action in the app is reachable here, so no capability is keyboard-only. */
export function Palette({ actions, onClose }: { actions: Action[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const usable = actions.filter((a) => a.enabled !== false)
    if (!needle) return usable
    return usable.filter((a) => a.label.toLowerCase().includes(needle))
  }, [actions, query])

  useEffect(() => setCursor(0), [query])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((c) => Math.min(c + 1, matches.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const action = matches[cursor]
      if (action) {
        onClose()
        action.run()
      }
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-label="Actions"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          placeholder="Search actions…"
          aria-label="Search actions"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul role="listbox">
          {matches.map((action, i) => (
            <li
              key={action.id}
              role="option"
              aria-selected={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                onClose()
                action.run()
              }}
            >
              <span>{action.label}</span>
              {action.hint && <span className="k">{action.hint}</span>}
            </li>
          ))}
          {matches.length === 0 && (
            <li aria-disabled="true" style={{ color: 'var(--zc-text-faint)' }}>
              No matching action
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
