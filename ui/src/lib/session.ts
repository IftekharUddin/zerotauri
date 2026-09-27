// The transcript state machine.
//
// One rule governs everything here: `turn_complete` is the sole authority on
// how a turn ended. Nothing else settles a turn, and a `turn_complete` whose
// generation does not match the turn we started is ignored, so a terminal
// event from an older turn can never settle a newer one.

import {
  GOAL_MAX_TURNS,
  continuationLabel,
  goalContinuation,
  goalPreamble,
  parseGoalMarker,
  stripGoalWrapper,
  formatGoalLimit,
  type GoalLimit,
  type GoalRun,
} from './goal.ts'
import type { Mode } from './modes.ts'
import { NO_OVERRIDES, UNKNOWN_IDENTITY } from './overrides.ts'
import type {
  Identity,
  MessageEntry,
  PlanEntry,
  SessionOverrides,
  SessionUpdate,
  ThinkingOptions,
} from './types.ts'

export type TurnPhase =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'responding'
  | 'calling-tool'
  | 'awaiting-approval'
  | 'cancelling'

export interface ToolEntry {
  kind: 'tool'
  id: string
  callId: string
  name: string
  input: unknown
  output?: string
  /** Which turn produced it, so the Changes panel can group per turn. */
  turn: number
}

export type Entry =
  | { kind: 'user'; id: string; text: string; turn: number }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; turn: number }
  | { kind: 'thought'; id: string; text: string; turn: number }
  | ToolEntry
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'warn' | 'error'; turn: number }

export interface PendingApproval {
  requestId: string
  toolName: string
  argumentsSummary: string
  /** Epoch milliseconds when the daemon will deny by policy. */
  deadline: number
}

export interface SessionState {
  sessionId: string
  agentAlias: string
  workspaceDir: string
  branch: string | null
  hash: string | null
  entries: Entry[]
  phase: TurnPhase
  activeTool: string | null
  /** Client-local turn identity echoed back by `turn_complete`. */
  generation: number
  pendingApproval: PendingApproval | null
  plan: PlanEntry[]
  contextInput: number | null
  contextMax: number | null
  turn: number
  /** The settings the daemon confirmed for this session. */
  overrides: SessionOverrides
  /** The configured provider and model, used where no override is set. */
  identity: Identity
  mode: Mode
  /** The goal loop, while one is running. */
  goal: GoalRun | null
  /**
   * What the session's model accepts for reasoning depth and display, and
   * what it has now. `null` on a daemon without per-session thinking controls.
   */
  thinking: ThinkingOptions | null
  /**
   * True while the session is on a turn that was already running when this
   * window opened it. Its completion carries a generation this window never
   * issued, so the fence stands down for that one event.
   */
  adoptedTurn: boolean
}

let counter = 0
const nextId = (prefix: string) => `${prefix}-${++counter}`

/** Reset the id sequence. Test-only; ids are otherwise opaque. */
export const __resetIds = () => {
  counter = 0
}

export function createSession(opts: {
  sessionId: string
  agentAlias: string
  workspaceDir: string
  branch?: string | null
  hash?: string | null
  plan?: PlanEntry[] | null
  overrides?: SessionOverrides
  identity?: Identity
  mode?: Mode
  /** The daemon reported a turn in flight at open time. */
  running?: boolean
}): SessionState {
  return {
    sessionId: opts.sessionId,
    agentAlias: opts.agentAlias,
    workspaceDir: opts.workspaceDir,
    branch: opts.branch ?? null,
    hash: opts.hash ?? null,
    entries: [],
    phase: opts.running ? 'working' : 'idle',
    activeTool: null,
    generation: 0,
    pendingApproval: null,
    plan: opts.plan ?? [],
    contextInput: null,
    contextMax: null,
    turn: 0,
    overrides: opts.overrides ?? NO_OVERRIDES,
    identity: opts.identity ?? UNKNOWN_IDENTITY,
    mode: opts.mode ?? 'build',
    goal: null,
    thinking: null,
    adoptedTurn: opts.running ?? false,
  }
}

/** Rebuild a transcript from a replayed daemon history. */
export function loadHistory(state: SessionState, messages: MessageEntry[]): SessionState {
  const entries: Entry[] = []
  let turn = 0
  for (const message of messages) {
    if (message.kind === 'tool_call') {
      entries.push({
        kind: 'tool',
        id: nextId('tool'),
        callId: message.tool_call_id ?? nextId('call'),
        name: message.tool_name ?? 'tool',
        input: message.tool_input,
        turn,
      })
      continue
    }
    if (message.kind === 'tool_result') {
      const callId = message.tool_call_id
      const match = [...entries]
        .reverse()
        .find((e): e is ToolEntry => e.kind === 'tool' && e.callId === callId)
      if (match) {
        match.output = message.tool_output ?? message.content
        continue
      }
      entries.push({
        kind: 'tool',
        id: nextId('tool'),
        callId: callId ?? nextId('call'),
        name: message.tool_name ?? 'tool',
        input: undefined,
        output: message.tool_output ?? message.content,
        turn,
      })
      continue
    }
    if (message.role === 'user') {
      turn += 1
      const text = stripGoalWrapper(message.content) ?? stripEnrichment(message.content)
      entries.push({ kind: 'user', id: nextId('user'), text, turn })
    } else if (message.role === 'assistant') {
      entries.push({
        kind: 'assistant',
        id: nextId('asst'),
        text: message.content,
        streaming: false,
        turn,
      })
    }
  }
  return { ...state, entries, turn }
}

/**
 * Drop a runtime-injected preamble from a restored user message. The daemon
 * enriches prompts before the model sees them; echoing that back would show
 * the user words they never typed.
 */
function stripEnrichment(content: string): string {
  const marker = content.lastIndexOf('\n\n')
  if (marker === -1) return content
  const head = content.slice(0, marker)
  if (/^\[[^\]]+\]/.test(head) && head.length < 400) return content.slice(marker + 2)
  return content
}

/** Begin a turn locally. The daemon confirms the end, never the start. */
export function startTurn(state: SessionState, prompt: string): SessionState {
  const turn = state.turn + 1
  return {
    ...state,
    generation: state.generation + 1,
    turn,
    phase: 'working',
    activeTool: null,
    adoptedTurn: false,
    entries: [...state.entries, { kind: 'user', id: nextId('user'), text: prompt, turn }],
  }
}

export function markCancelling(state: SessionState): SessionState {
  return { ...state, phase: 'cancelling' }
}

export function isBusy(state: SessionState): boolean {
  return state.phase !== 'idle'
}

/** Apply one streamed daemon event. Unknown types are ignored by design. */
export function applyUpdate(state: SessionState, update: SessionUpdate): SessionState {
  if (update.session_id !== state.sessionId) return state

  switch (update.type) {
    case 'agent_message_chunk': {
      const text = (update as { text: string }).text
      const entries = [...state.entries]
      const at = behindNotices(entries)
      const last = entries[at]
      if (last && last.kind === 'assistant' && last.streaming) {
        entries[at] = { ...last, text: last.text + text }
      } else {
        entries.push({
          kind: 'assistant',
          id: nextId('asst'),
          text,
          streaming: true,
          turn: state.turn,
        })
      }
      return { ...state, entries, phase: 'responding', activeTool: null }
    }

    case 'agent_thought_chunk': {
      const text = (update as { text: string }).text
      const entries = [...state.entries]
      const at = behindNotices(entries)
      const last = entries[at]
      if (last && last.kind === 'thought' && last.turn === state.turn) {
        entries[at] = { ...last, text: last.text + text }
      } else {
        entries.push({ kind: 'thought', id: nextId('thought'), text, turn: state.turn })
      }
      return { ...state, entries, phase: 'thinking' }
    }

    case 'tool_call': {
      const call = update as { tool_call_id: string; name: string; raw_input: unknown }
      const entries = sealStreaming(state.entries)
      entries.push({
        kind: 'tool',
        id: nextId('tool'),
        callId: call.tool_call_id,
        name: call.name,
        input: call.raw_input,
        turn: state.turn,
      })
      return { ...state, entries, phase: 'calling-tool', activeTool: call.name }
    }

    case 'tool_result': {
      const result = update as { tool_call_id: string; raw_output: string }
      const entries = [...state.entries]
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i]
        if (entry && entry.kind === 'tool' && entry.callId === result.tool_call_id) {
          entries[i] = { ...entry, output: result.raw_output }
          break
        }
      }
      return { ...state, entries, phase: 'working', activeTool: null }
    }

    case 'approval_request': {
      const request = update as {
        request_id: string
        tool_name: string
        arguments_summary: string
        timeout_secs: number
      }
      return {
        ...state,
        phase: 'awaiting-approval',
        pendingApproval: {
          requestId: request.request_id,
          toolName: request.tool_name,
          argumentsSummary: request.arguments_summary,
          deadline: Date.now() + request.timeout_secs * 1000,
        },
      }
    }

    case 'context_usage': {
      const usage = update as { input_tokens?: number; max_context_tokens?: number }
      return {
        ...state,
        contextInput: usage.input_tokens ?? state.contextInput,
        contextMax: usage.max_context_tokens ?? state.contextMax,
      }
    }

    case 'plan':
      return { ...state, plan: (update as { entries: PlanEntry[] }).entries }

    case 'history_trimmed': {
      const trim = update as { dropped_messages: number; kept_turns: number }
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            kind: 'notice',
            id: nextId('notice'),
            tone: 'warn',
            text: `Earlier context was trimmed to fit the window: ${trim.dropped_messages} message(s) dropped, ${trim.kept_turns} turn(s) kept.`,
            turn: state.turn,
          },
        ],
      }
    }

    case 'turn_complete': {
      const done = update as {
        outcome: 'completed' | 'cancelled' | 'failed'
        content: string
        client_turn_generation?: number
      }
      // Generation fencing: a terminal event from a turn we already replaced
      // must not settle the current one. A turn adopted at open time carries
      // a generation this window never issued, so it settles on any
      // completion, and only that one.
      if (
        typeof done.client_turn_generation === 'number' &&
        done.client_turn_generation !== state.generation &&
        !state.adoptedTurn
      ) {
        return state
      }
      const entries = sealStreaming(state.entries)
      if (done.outcome !== 'completed' && done.content.trim()) {
        entries.push({
          kind: 'notice',
          id: nextId('notice'),
          tone: done.outcome === 'failed' ? 'error' : 'info',
          text: done.content,
          turn: state.turn,
        })
      }
      return settleGoal(
        {
          ...state,
          entries,
          phase: 'idle',
          activeTool: null,
          pendingApproval: null,
          adoptedTurn: false,
        },
        done.outcome,
        done.content,
      )
    }

    default:
      return state
  }
}

/**
 * The index of the last entry that is not a notice. A notice posted while a
 * reply streams, such as a refused mode change, sits after the reply instead
 * of splitting it in two.
 */
function behindNotices(entries: Entry[]): number {
  let at = entries.length - 1
  while (at >= 0 && entries[at]?.kind === 'notice') at -= 1
  return at
}

/** Close any open streaming assistant entry. */
function sealStreaming(entries: Entry[]): Entry[] {
  const next = [...entries]
  const last = next[next.length - 1]
  if (last && last.kind === 'assistant' && last.streaming) {
    next[next.length - 1] = { ...last, streaming: false }
  }
  return next
}

// ── Modes and the goal loop ─────────────────────────────────────────
//
// These run only inside a turn_complete that passed the generation fence, or
// from a user action, so a late terminal event from a replaced turn can never
// step or stop a goal.

/** Put the session in a mode locally. Leaving goal mode ends a run. */
export function withMode(state: SessionState, mode: Mode): SessionState {
  if (state.mode === mode) return state
  const next = { ...state, mode }
  return next.goal ? stopGoal(next, `Goal stopped: switched to ${mode} mode.`) : next
}

/** Start a goal: the transcript shows the objective, the daemon gets the preamble. */
export function beginGoal(
  state: SessionState,
  objective: string,
  limit: GoalLimit = GOAL_MAX_TURNS,
): { state: SessionState; sent: string } {
  const started = startTurn(state, objective)
  const run: GoalRun = { objective, turn: 1, max: limit, next: null }
  const notice =
    limit === null
      ? 'Goal started with no turn limit. This app keeps the agent going until it reports done or blocked, or you stop it.'
      : `Goal started. This app keeps the agent going for up to ${formatGoalLimit(limit)}, until it reports done or blocked.`
  return {
    state: pushNotice({ ...started, goal: run }, notice),
    sent: goalPreamble(objective),
  }
}

const capNotice = (turn: number, max: number): string =>
  `Goal stopped at turn ${turn}: the limit is ${formatGoalLimit(max)} and the agent has not reported done.`

/**
 * Change the turn limit of a running goal. A limit at or below the turn
 * already reached ends a goal that is waiting to continue; one still in a
 * turn ends when that turn completes.
 */
export function withGoalLimit(state: SessionState, limit: GoalLimit): SessionState {
  const run = state.goal
  if (!run || run.max === limit) return state
  const updated: SessionState = { ...state, goal: { ...run, max: limit } }
  if (limit !== null && run.turn >= limit && run.next === 'continue') {
    return { ...pushNotice(updated, capNotice(run.turn, limit), 'warn'), goal: null }
  }
  return updated
}

/** The next goal turn, when the last one asked for it. */
export function continueGoal(state: SessionState): { state: SessionState; sent: string } | null {
  const run = state.goal
  if (!run || run.next !== 'continue') return null
  const turn = run.turn + 1
  return {
    state: { ...startTurn(state, continuationLabel(turn, run.max)), goal: { ...run, turn, next: null } },
    sent: goalContinuation(),
  }
}

export function stopGoal(state: SessionState, notice: string): SessionState {
  if (!state.goal) return state
  return { ...pushNotice(state, notice), goal: null }
}

/** The agent's final text in the current turn, if it wrote any. */
function lastReply(state: SessionState): string | null {
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[i]
    if (!entry || entry.turn !== state.turn) break
    if (entry.kind === 'assistant') return entry.text
  }
  return null
}

function settleGoal(
  state: SessionState,
  outcome: 'completed' | 'cancelled' | 'failed',
  content: string,
): SessionState {
  const run = state.goal
  if (!run) return state
  if (outcome !== 'completed') {
    return { ...pushNotice(state, `Goal stopped: the turn was ${outcome}.`, 'warn'), goal: null }
  }
  const marker = parseGoalMarker(lastReply(state) ?? content)
  if (marker.kind === 'done') {
    const turns = run.turn === 1 ? '1 turn' : `${run.turn} turns`
    return { ...pushNotice(state, `Goal reported done after ${turns}.`), goal: null }
  }
  if (marker.kind === 'blocked') {
    const text = marker.reason ? `Goal blocked: ${marker.reason}` : 'Goal blocked.'
    return { ...pushNotice(state, text, 'warn'), goal: null }
  }
  if (run.max !== null && run.turn >= run.max) {
    return { ...pushNotice(state, capNotice(run.turn, run.max), 'warn'), goal: null }
  }
  return { ...state, goal: { ...run, next: 'continue' } }
}

export function clearApproval(state: SessionState): SessionState {
  return {
    ...state,
    pendingApproval: null,
    phase: state.phase === 'awaiting-approval' ? 'working' : state.phase,
  }
}

export function pushNotice(
  state: SessionState,
  text: string,
  tone: 'info' | 'warn' | 'error' = 'info',
): SessionState {
  return {
    ...state,
    entries: [
      ...state.entries,
      { kind: 'notice', id: nextId('notice'), text, tone, turn: state.turn },
    ],
  }
}

export function phaseLabel(state: SessionState): string {
  switch (state.phase) {
    case 'idle':
      return 'Ready'
    case 'working':
      return 'Working'
    case 'thinking':
      return 'Thinking'
    case 'responding':
      return 'Responding'
    case 'calling-tool':
      return state.activeTool ? `Running ${state.activeTool}` : 'Running a tool'
    case 'awaiting-approval':
      return 'Waiting for you'
    case 'cancelling':
      return 'Cancelling'
  }
}
