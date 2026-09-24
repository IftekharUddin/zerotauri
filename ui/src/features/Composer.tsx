import { useEffect, useRef } from 'react'

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
    }
  }

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        placeholder={disabled ? 'Reconnecting…' : `Ask ${agentAlias} for a change…`}
        aria-label="Message"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="row">
        <button type="button" className="ghost" onClick={onToggleThoughts} aria-pressed={showThoughts}>
          Thinking: {showThoughts ? 'shown' : 'hidden'}
        </button>
        <span className="hint">Enter to send · Shift+Enter for a new line · ⌘K for actions</span>
        <span className="spacer" />
        {busy ? (
          <button type="button" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={disabled || value.trim().length === 0}
            onClick={onSubmit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
