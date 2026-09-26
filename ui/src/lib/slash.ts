// Slash commands typed in the message box.
//
// Table-driven, like zerocode's: one spec per command with its aliases, so
// the parser, the help text, and the docs all read from the same list. A
// command runs locally and is never sent to the agent; an unknown one is
// reported rather than sent, and `//` sends a literal leading slash.

import { goalLabel } from './goal.ts'
import type { PlanSupport } from './modes.ts'
import { effectiveIdentity } from './overrides.ts'
import type { SessionState } from './session.ts'
import type { ConnectionInfo } from './types.ts'

export interface CommandSpec {
  name: string
  aliases: readonly string[]
  /** How the argument reads in help, if the command takes one. */
  args?: string
  summary: string
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'help', aliases: ['?'], summary: 'List these commands.' },
  {
    name: 'status',
    aliases: [],
    summary: 'Show the agent, provider, model, mode, and daemon for this session.',
  },
  { name: 'mode', aliases: [], args: 'build|plan|goal', summary: 'Switch mode.' },
  { name: 'build', aliases: [], summary: 'Switch to build mode.' },
  { name: 'plan', aliases: [], summary: 'Switch to plan mode: read-only, enforced by the daemon.' },
  {
    name: 'goal',
    aliases: [],
    args: '[objective]',
    summary: 'Switch to goal mode, and start the goal if an objective is given.',
  },
  { name: 'model', aliases: [], args: '[id]', summary: 'Pick a model, or set one by id.' },
  {
    name: 'provider',
    aliases: ['model-provider'],
    args: '[ref]',
    summary: 'Pick a provider, or set one by reference.',
  },
  {
    name: 'agent',
    aliases: [],
    args: '[alias]',
    summary: 'Open a new session with another agent in this folder.',
  },
  { name: 'new', aliases: ['new-session'], summary: 'Start a new session.' },
  { name: 'close', aliases: [], summary: 'Close this session. Its transcript is kept.' },
  { name: 'cancel', aliases: ['stop'], summary: 'Stop the current turn.' },
  {
    name: 'clear',
    aliases: [],
    summary: 'Clear the transcript and Changes in this window. The daemon keeps its history.',
  },
  {
    name: 'thoughts',
    aliases: ['thinking', 'toggle-thinking'],
    summary: "Show or hide the agent's thoughts.",
  },
  { name: 'sessions', aliases: [], summary: 'Show or hide the session rail.' },
  { name: 'changes', aliases: [], summary: 'Show or hide the Changes panel.' },
  { name: 'forget', aliases: [], summary: 'Forget the settings saved for this session.' },
]

export type Parsed =
  | { kind: 'text'; text: string }
  | { kind: 'command'; name: string; arg: string }
  | { kind: 'unknown'; name: string }

export function findCommand(name: string): CommandSpec | null {
  const wanted = name.toLowerCase()
  return COMMANDS.find((c) => c.name === wanted || c.aliases.includes(wanted)) ?? null
}

/** Classify what was typed. Expects the draft already trimmed. */
export function parseInput(input: string): Parsed {
  if (!input.startsWith('/')) return { kind: 'text', text: input }
  if (input.startsWith('//')) return { kind: 'text', text: input.slice(1) }
  // A lone slash, or a slash followed by a space, is ordinary text.
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input)
  const token = match?.[1]
  if (!match || token === undefined) return { kind: 'text', text: input }
  const spec = findCommand(token)
  if (!spec) return { kind: 'unknown', name: token }
  return { kind: 'command', name: spec.name, arg: (match[2] ?? '').trim() }
}

export function helpText(commands: readonly CommandSpec[] = COMMANDS): string {
  const lines = commands.map((c) => {
    const usage = `/${c.name}${c.args ? ` ${c.args}` : ''}`
    const also = c.aliases.length ? ` Also ${c.aliases.map((a) => `/${a}`).join(', ')}.` : ''
    return `${usage}: ${c.summary}${also}`
  })
  return ['Commands:', ...lines, 'Start a message with // to send a leading slash.'].join('\n')
}

export function statusText(
  state: SessionState,
  info: ConnectionInfo | null,
  planSupport: PlanSupport,
): string {
  const identity = effectiveIdentity(state)
  const source = (overridden: boolean, known: boolean) =>
    overridden ? 'set for this session' : known ? 'configured default' : 'not known'
  const mode = state.goal
    ? `${goalLabel(state.goal)} (objective: ${state.goal.objective})`
    : state.mode === 'plan'
      ? 'plan (enforced by the daemon)'
      : state.mode === 'build' && planSupport === 'unsupported'
        ? 'build (this daemon does not enforce plan mode)'
        : state.mode
  const lines = [
    `Agent: ${state.agentAlias}`,
    `Session: ${state.sessionId}`,
    `Folder: ${state.workspaceDir}`,
    `Provider: ${identity.provider ?? 'default'} (${source(state.overrides.modelProvider !== null, identity.provider !== null)})`,
    `Model: ${identity.model ?? 'default'} (${source(state.overrides.model !== null, identity.model !== null)})`,
    `Mode: ${mode}`,
  ]
  if (info) {
    lines.push(`Daemon: v${info.serverVersion}, pid ${info.serverPid}, ${info.endpoint}`)
  }
  return lines.join('\n')
}
