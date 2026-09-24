import { parseBlocks, splitInline } from './markdown'

/** Render transcript text. Raw HTML is never interpreted. */
export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source)
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === 'code' ? (
          <pre className="code" key={`b${i}`}>
            <code>{block.text}</code>
          </pre>
        ) : (
          <p key={`b${i}`} style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>
            {splitInline(block.text).map((span, j) =>
              span.code ? (
                <code className="inline" key={`b${i}-s${j}`}>
                  {span.text}
                </code>
              ) : (
                <span key={`b${i}-s${j}`}>{span.text}</span>
              ),
            )}
          </p>
        ),
      )}
    </>
  )
}
