// Client-side diffs derived from tool inputs.
//
// The daemon exposes no working-tree diff, and this app never reads the
// repository itself: reading a daemon-supplied path would be wrong the moment
// the daemon is remote. So changes are reconstructed from what the agent
// asked the tool to do: `file_edit` carries the exact old and new strings,
// `file_write` carries the full new content. Line numbers are deliberately
// absent, because deriving them would need the file on disk.

export type DiffTag = 'context' | 'add' | 'remove'

export interface DiffLine {
  tag: DiffTag
  text: string
}

export interface FileChange {
  path: string
  /** `edit` came from file_edit, `write` from file_write. */
  mode: 'edit' | 'write'
  added: number
  removed: number
  lines: DiffLine[]
  truncated: boolean
}

/** Beyond this, diffing costs more than the answer is worth. */
const MAX_DIFF_LINES = 1200
/** Rendered context lines around each changed run. */
const CONTEXT = 3

const splitLines = (text: string): string[] => (text === '' ? [] : text.split('\n'))

/**
 * Longest common subsequence over lines, then a unified rendering with
 * bounded context. Falls back to a whole-block replacement when either side
 * is too large to diff cheaply.
 */
export function diffLines(before: string, after: string): { lines: DiffLine[]; truncated: boolean } {
  const a = splitLines(before)
  const b = splitLines(after)

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return {
      lines: [
        ...a.slice(0, 40).map((text): DiffLine => ({ tag: 'remove', text })),
        ...b.slice(0, 40).map((text): DiffLine => ({ tag: 'add', text })),
      ],
      truncated: true,
    }
  }

  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i]
      const nextRow = table[i + 1]
      if (!row || !nextRow) continue
      row[j] = a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const full: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      full.push({ tag: 'context', text: a[i] ?? '' })
      i += 1
      j += 1
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      full.push({ tag: 'remove', text: a[i] ?? '' })
      i += 1
    } else {
      full.push({ tag: 'add', text: b[j] ?? '' })
      j += 1
    }
  }
  while (i < a.length) {
    full.push({ tag: 'remove', text: a[i] ?? '' })
    i += 1
  }
  while (j < b.length) {
    full.push({ tag: 'add', text: b[j] ?? '' })
    j += 1
  }

  return { lines: collapseContext(full), truncated: false }
}

/** Keep only CONTEXT lines of unchanged text around each changed run. */
function collapseContext(lines: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.tag === 'context') return
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k += 1) {
      keep[k] = true
    }
  })

  const out: DiffLine[] = []
  let skipping = false
  lines.forEach((line, index) => {
    if (keep[index]) {
      skipping = false
      out.push(line)
    } else if (!skipping) {
      skipping = true
      out.push({ tag: 'context', text: '…' })
    }
  })
  return out
}

interface ToolLike {
  name: string
  input: unknown
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * Turn a file-mutating tool call into a renderable change. Returns null for
 * every other tool, which is most of them.
 */
export function changeFromTool(tool: ToolLike): FileChange | null {
  const input = asRecord(tool.input)
  if (!input) return null

  const path =
    asString(input.path) ?? asString(input.file_path) ?? asString(input.filename) ?? null
  if (!path) return null

  if (tool.name === 'file_edit') {
    const before = asString(input.old_string)
    const after = asString(input.new_string)
    if (before === null || after === null) return null
    const { lines, truncated } = diffLines(before, after)
    return {
      path,
      mode: 'edit',
      added: lines.filter((l) => l.tag === 'add').length,
      removed: lines.filter((l) => l.tag === 'remove').length,
      lines,
      truncated,
    }
  }

  if (tool.name === 'file_write') {
    const content = asString(input.content) ?? asString(input.contents)
    if (content === null) return null
    const all = splitLines(content)
    const shown = all.slice(0, 200)
    return {
      path,
      mode: 'write',
      added: all.length,
      removed: 0,
      lines: shown.map((text): DiffLine => ({ tag: 'add', text })),
      truncated: all.length > shown.length,
    }
  }

  return null
}
