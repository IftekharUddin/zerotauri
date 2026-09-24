import { useEffect, useRef } from 'react'

import { Markdown } from '../lib/MarkdownView'
import type { Entry, SessionState } from '../lib/session'

function summarize(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input
  const record = input as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'query', 'pattern', 'url']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  const json = JSON.stringify(input)
  return json.length > 140 ? `${json.slice(0, 140)}…` : json
}

function ToolCard({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const running = entry.output === undefined
  return (
    <details className="tool">
      <summary>
        <span className="tname">{entry.name}</span>
        <span className="tsum">{summarize(entry.input)}</span>
        {running && <span className="spin">running…</span>}
      </summary>
      <div className="detail">
        <h4>Input</h4>
        <pre>{JSON.stringify(entry.input, null, 2)}</pre>
        {entry.output !== undefined && (
          <>
            <h4>Output</h4>
            <pre>{entry.output}</pre>
          </>
        )}
      </div>
    </details>
  )
}

export function Transcript({
  session,
  showThoughts,
}: {
  session: SessionState
  showThoughts: boolean
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Follow the tail only while the reader is already at the bottom, so
  // scrolling back to read something is not yanked away by new output.
  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
  }

  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [session.entries])

  const visible = session.entries.filter((e) => showThoughts || e.kind !== 'thought')

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div role="log" aria-live="polite" aria-label="Conversation">
        {visible.length === 0 && (
          <p className="empty">Describe a change and the agent will work in this folder.</p>
        )}
        {visible.map((entry) => {
          switch (entry.kind) {
            case 'user':
              return (
                <div className="entry user" key={entry.id}>
                  <div className="who">You</div>
                  <div className="bubble">{entry.text}</div>
                </div>
              )
            case 'assistant':
              return (
                <div className="entry assistant" key={entry.id}>
                  <div className="who">{session.agentAlias}</div>
                  <div className="bubble">
                    <Markdown source={entry.text} />
                    {entry.streaming && <span className="cursor" aria-hidden="true">&nbsp;</span>}
                  </div>
                </div>
              )
            case 'thought':
              return (
                <div className="entry thought" key={entry.id}>
                  <div className="who">Thinking</div>
                  <div className="bubble">{entry.text}</div>
                </div>
              )
            case 'tool':
              return (
                <div className="entry" key={entry.id}>
                  <ToolCard entry={entry} />
                </div>
              )
            case 'notice':
              return (
                <div className="entry" key={entry.id}>
                  <div className={`notice ${entry.tone}`}>{entry.text}</div>
                </div>
              )
          }
        })}
        <div ref={endRef} />
      </div>
    </div>
  )
}
