// Build, plan, and goal modes.
//
// Build and plan belong to the daemon: plan mode is a per-turn tool
// allowlist the runtime enforces, switched with `session/configure`. Goal is
// this app's own loop and runs the agent in build mode, so switching between
// build and goal never reaches the daemon.

import { formatGoalLimit, type GoalLimit } from './goal.ts'

export type Mode = 'build' | 'plan' | 'goal'

/**
 * What this app has learned about the connected daemon's plan mode. It is
 * learned from the first real request, never probed, and forgotten when the
 * daemon process changes.
 */
export type PlanSupport = 'unknown' | 'supported' | 'unsupported'

export const MODES: readonly Mode[] = ['build', 'plan', 'goal']

/** The next mode in the cycle, skipping plan where the daemon cannot enforce it. */
export function nextMode(mode: Mode, planSupport: PlanSupport): Mode {
  const order: readonly Mode[] = planSupport === 'unsupported' ? ['build', 'goal'] : MODES
  const at = order.indexOf(mode)
  return order[(at + 1) % order.length] ?? 'build'
}

export function parseMode(text: string): Mode | null {
  const name = text.trim().toLowerCase()
  return (MODES as readonly string[]).includes(name) ? (name as Mode) : null
}

/** What the daemon is told. Goal runs the agent normally; the loop is ours. */
export function wireMode(mode: Mode): 'build' | 'plan' {
  return mode === 'plan' ? 'plan' : 'build'
}

export function modeChangeNeedsDaemon(from: Mode, to: Mode): boolean {
  return wireMode(from) !== wireMode(to)
}

export const MODE_SUMMARY: Record<Mode, string> = {
  build: 'The agent can use every tool it is allowed.',
  plan: 'Read-only. The daemon refuses any tool that could change files, run commands, or reach the network.',
  goal: 'Your next message becomes an objective, and this app keeps the agent going until it reports done or blocked.',
}

export const PLAN_UNSUPPORTED =
  'This daemon does not enforce plan mode, so the session stays in build mode. Plan mode needs a ZeroClaw daemon that enforces it at runtime.'

export const MODE_BUSY =
  'A turn is running. Wait for it to finish, or stop it, before switching mode.'

/** The transcript line recorded when a session changes mode. */
export function modeNotice(mode: Mode, goalLimit: GoalLimit): string {
  if (mode === 'goal') {
    const limit =
      goalLimit === null
        ? 'There is no turn limit: it runs until the agent reports done or blocked, or you stop it.'
        : `It stops after ${formatGoalLimit(goalLimit)} at most.`
    return `Goal mode. ${MODE_SUMMARY.goal} ${limit} It also stops when this window closes.`
  }
  return `${mode === 'plan' ? 'Plan' : 'Build'} mode. ${MODE_SUMMARY[mode]}`
}
