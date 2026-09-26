import { useEffect, useMemo, useState } from 'react'

export interface Action {
  id: string
  label: string
  hint?: string
  run: () => void
  enabled?: boolean
}

interface PaletteProps {
  actions: Action[]
  onClose: () => void
  /** Shown above the search box when the palette is used as a picker. */
  title?: string
  placeholder?: string
  /** True while the choices are still being fetched. */
  loading?: boolean
  /** A line about the list itself, such as why it is empty. */
  note?: string | null
  /** An extra row built from the query, offered unless a choice matches it exactly. */
  fallback?: (query: string) => Action | null
}

/**
 * Every action in the app is reachable here, so no capability is
 * keyboard-only. The same component doubles as the model, provider, and
 * agent picker: those pass their own choices and a title.
 */
export function Palette({
  actions,
  onClose,
  title,
  placeholder = 'Search actions…',
  loading = false,
  note = null,
  fallback,
}: PaletteProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const usable = actions.filter((a) => a.enabled !== false)
    const found = needle ? usable.filter((a) => a.label.toLowerCase().includes(needle)) : usable
    const typed = query.trim()
    if (fallback && typed && !found.some((a) => a.label.toLowerCase() === needle)) {
      const extra = fallback(typed)
      if (extra) return [...found, extra]
    }
    return found
  }, [actions, query, fallback])

  useEffect(() => setCursor(0), [query])
  const selected = Math.min(cursor, Math.max(matches.length - 1, 0))

  const choose = (action: Action) => {
    onClose()
    action.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor(Math.min(selected + 1, matches.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor(Math.max(selected - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const action = matches[selected]
      if (action) choose(action)
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-label={title ?? 'Actions'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && <div className="ptitle">{title}</div>}
        <input
          autoFocus
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul role="listbox">
          {loading && (
            <li aria-disabled="true" className="muted">
              Loading…
            </li>
          )}
          {note && (
            <li aria-disabled="true" className="muted">
              {note}
            </li>
          )}
          {matches.map((action, i) => (
            <li
              key={action.id}
              role="option"
              aria-selected={i === selected}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(action)
              }}
            >
              <span>{action.label}</span>
              {action.hint && <span className="k">{action.hint}</span>}
            </li>
          ))}
          {matches.length === 0 && !loading && !note && (
            <li aria-disabled="true" className="muted">
              Nothing matches
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
