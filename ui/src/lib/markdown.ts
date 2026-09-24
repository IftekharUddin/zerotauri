// Block-level Markdown parsing, kept free of JSX so it is directly testable.
//
// Transcript text is untrusted: it comes from a model and from repository
// content the model read. Nothing here interprets raw HTML, follows a link,
// or evaluates anything. Fenced code, inline code, and paragraphs cover what
// a coding transcript actually contains.

export interface Block {
  kind: 'code' | 'text'
  text: string
  lang?: string
}

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.split('\n')
  let buffer: string[] = []
  let inCode = false
  let lang = ''

  const flushText = () => {
    if (buffer.length) blocks.push({ kind: 'text', text: buffer.join('\n') })
    buffer = []
  }

  for (const line of lines) {
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      if (inCode) {
        blocks.push({ kind: 'code', text: buffer.join('\n'), lang })
        buffer = []
        inCode = false
        lang = ''
      } else {
        flushText()
        inCode = true
        lang = (fence[1] ?? '').trim()
      }
      continue
    }
    buffer.push(line)
  }

  if (inCode) blocks.push({ kind: 'code', text: buffer.join('\n'), lang })
  else flushText()

  return blocks.filter((b) => b.kind === 'code' || b.text.trim().length > 0)
}

export interface InlineSpan {
  code: boolean
  text: string
}

/** Split a line on inline backticks, leaving everything else as plain text. */
export function splitInline(text: string): InlineSpan[] {
  const out: InlineSpan[] = []
  const pattern = /`([^`]+)`/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) out.push({ code: false, text: text.slice(cursor, match.index) })
    out.push({ code: true, text: match[1] ?? '' })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) out.push({ code: false, text: text.slice(cursor) })
  return out
}
