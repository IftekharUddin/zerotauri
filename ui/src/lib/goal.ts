// The goal loop's protocol with the model.
//
// This is byte-for-byte the protocol zerocode's Code pane uses, so a goal
// session reads the same in either client: the first prompt wraps the
// objective in a preamble asking for a status marker, and each completed turn
// is followed by a continuation until the agent reports done or blocked, or
// the turn cap is reached. Model-facing text is not localized, because the
// marker is parsed, not read.

/**
 * The default turn limit. A model that never reports done would otherwise
 * run until someone noticed. The limit can be raised or removed; a goal
 * with no limit runs until the agent reports done or blocked, a turn fails
 * or is cancelled, the connection drops, or the window closes.
 */
export const GOAL_MAX_TURNS = 10

/** Most turns a limit may name. Past this, "none" is the honest setting. */
export const GOAL_LIMIT_MAX = 10_000

/** How many turns a goal may run; `null` is no limit. */
export type GoalLimit = number | null

export const formatGoalLimit = (limit: GoalLimit): string =>
  limit === null ? 'no limit' : limit === 1 ? '1 turn' : `${limit} turns`

const NO_LIMIT_WORDS = new Set(['none', 'unlimited', 'off', 'infinite', 'infinity', '∞'])

/** Read a limit as typed. `undefined` means the text is not a limit. */
export function parseGoalLimit(text: string): GoalLimit | undefined {
  const word = text.trim().toLowerCase()
  if (NO_LIMIT_WORDS.has(word)) return null
  if (!/^\d{1,5}$/.test(word)) return undefined
  const turns = Number(word)
  return turns >= 1 && turns <= GOAL_LIMIT_MAX ? turns : undefined
}

const PREAMBLE_HEAD = 'You are working toward the objective below. Work on it now.\n'
const OBJECTIVE_MARK = '\n\nObjective:\n'

export function goalPreamble(objective: string): string {
  return (
    PREAMBLE_HEAD +
    'End every reply with exactly one status line, alone on the last line:\n' +
    '[GOAL: done] when the objective is fully achieved,\n' +
    '[GOAL: continue] when more work remains,\n' +
    '[GOAL: blocked <reason>] when you cannot proceed without the user.' +
    OBJECTIVE_MARK +
    objective
  )
}

export function goalContinuation(): string {
  return (
    'Continue working toward the objective. End your reply with [GOAL: done], ' +
    '[GOAL: continue], or [GOAL: blocked <reason>].'
  )
}

export type GoalMarker =
  | { kind: 'done' }
  | { kind: 'continue' }
  | { kind: 'blocked'; reason: string }
  /** No marker. Treated as continue, so a forgetful model runs into the cap. */
  | { kind: 'missing' }

const trimChars = (text: string, chars: string, start: boolean, end: boolean): string => {
  let from = 0
  let to = text.length
  while (start && from < to && chars.includes(text[from] ?? '')) from += 1
  while (end && to > from && chars.includes(text[to - 1] ?? '')) to -= 1
  return text.slice(from, to)
}

/** Read the status marker off the last non-empty line of a reply. */
export function parseGoalMarker(reply: string): GoalMarker {
  const last = reply
    .split('\n')
    .reverse()
    .find((line) => line.trim() !== '')
  if (last === undefined) return { kind: 'missing' }
  // Models wrap the line in emphasis or trail it with punctuation often
  // enough that not allowing for it would read as a missing marker.
  const trimmed = trimChars(trimChars(last.trim(), '`* \t', true, true), '.!)', false, true).trim()
  const lowered = trimmed.toLowerCase()
  if (!lowered.startsWith('[goal:') || !lowered.endsWith(']')) return { kind: 'missing' }
  const inner = lowered.slice('[goal:'.length, -1).trim()
  if (inner === 'done') return { kind: 'done' }
  if (inner === 'continue') return { kind: 'continue' }
  if (inner.startsWith('blocked')) {
    // Keep the reason as the model wrote it, not lowercased.
    const original = trimmed.slice('[goal:'.length, -1).trim()
    return { kind: 'blocked', reason: original.slice('blocked'.length).trim() }
  }
  return { kind: 'missing' }
}

/** A goal in progress. `next` is set when a completed turn asks for another. */
export interface GoalRun {
  objective: string
  turn: number
  max: GoalLimit
  next: 'continue' | null
}

export const goalLabel = (run: GoalRun): string => `goal ${run.turn}/${run.max ?? '∞'}`

/** What the transcript shows for a continuation this app sent. */
export const continuationLabel = (turn: number, max: GoalLimit): string =>
  `continue (goal turn ${turn}${max === null ? '' : `/${max}`})`

/**
 * The words the user typed, for a goal prompt restored from history. The
 * daemon stores what was sent, preamble included; showing that back would
 * put words in the user's mouth. Returns `null` for any other message.
 */
export function stripGoalWrapper(content: string): string | null {
  const start = content.indexOf(PREAMBLE_HEAD)
  if (start !== -1) {
    const mark = content.indexOf(OBJECTIVE_MARK, start)
    if (mark !== -1) return content.slice(mark + OBJECTIVE_MARK.length)
  }
  if (content.trimEnd().endsWith(goalContinuation())) return 'continue (goal turn)'
  return null
}
