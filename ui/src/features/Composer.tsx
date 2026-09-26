import { useEffect, useRef, type ReactNode } from 'react'

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  busy: boolean
  disabled: boolean
  showThoughts: boolean
  onToggleThoughts: () => void
  agentAlias: string
  /** Session settings, shown on their own row above the message box. */
  controls?: ReactNode
  /** Why sending is paused right now, if it is. Typing stays allowed. */
  hold?: string | null
  /** Shift+Tab in the message box. */
  onCycleMode?: () => void
  placeholder?: string
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  disabled,
  showThoughts,
  onToggleThoughts,
  agentAlias,
  controls,
  hold = null,
  onCycleMode,
  placeholder,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the content up to the CSS max, then scroll.
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 190)}px`
  }, [value])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    } else if (event.key === 'Tab' && event.shiftKey && onCycleMode) {
      // Bound only here, not window-wide, so Shift+Tab still moves focus
      // backwards everywhere else in the window.
      event.preventDefault()
      onCycleMode()
    }
  }

  return (
    <div className="composer">
      {controls}
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        placeholder={disabled ? 'Reconnecting…' : (placeholder ?? `Ask ${agentAlias} for a change…`)}
        aria-label="Message"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="row">
        <button type="button" className="ghost" onClick={onToggleThoughts} aria-pressed={showThoughts}>
          Thoughts: {showThoughts ? 'shown' : 'hidden'}
        </button>
        <span className={hold ? 'hint held' : 'hint'} role={hold ? 'status' : undefined}>
          {hold ?? 'Enter to send · Shift+Enter new line · / commands · Shift+Tab modes · ⌘K actions'}
        </span>
        <span className="spacer" />
        {busy ? (
          <button type="button" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={disabled || hold !== null || value.trim().length === 0}
            onClick={onSubmit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
