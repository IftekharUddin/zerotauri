import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GOAL_MAX_TURNS,
  goalContinuation,
  goalPreamble,
  parseGoalMarker,
  stripGoalWrapper,
} from './goal.ts'
import { modeChangeNeedsDaemon, nextMode, parseMode, wireMode } from './modes.ts'
import {
  __resetIds,
  applyUpdate,
  beginGoal,
  continueGoal,
  createSession,
  loadHistory,
  startTurn,
  stopGoal,
  withMode,
  type SessionState,
} from './session.ts'
import type { SessionUpdate } from './types.ts'

const fresh = (): SessionState => {
  __resetIds()
  return withMode(
    createSession({ sessionId: 's1', agentAlias: 'coder', workspaceDir: '/repo' }),
    'goal',
  )
}

const reply = (text: string): SessionUpdate => ({
  type: 'agent_message_chunk',
  session_id: 's1',
  text,
})

const complete = (
  state: SessionState,
  outcome: 'completed' | 'cancelled' | 'failed' = 'completed',
  content = '',
): SessionState =>
  applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome,
    content,
    client_turn_generation: state.generation,
  })

const notices = (state: SessionState) =>
  state.entries.filter((e) => e.kind === 'notice').map((e) => (e.kind === 'notice' ? e.text : ''))

// ── Protocol ─────────────────────────────────────────────────────────

test('the preamble and continuation match zerocode byte for byte', () => {
  assert.equal(
    goalPreamble('ship the parser'),
    'You are working toward the objective below. Work on it now.\n' +
      'End every reply with exactly one status line, alone on the last line:\n' +
      '[GOAL: done] when the objective is fully achieved,\n' +
      '[GOAL: continue] when more work remains,\n' +
      '[GOAL: blocked <reason>] when you cannot proceed without the user.\n\n' +
      'Objective:\nship the parser',
  )
  assert.equal(
    goalContinuation(),
    'Continue working toward the objective. End your reply with [GOAL: done], [GOAL: continue], or [GOAL: blocked <reason>].',
  )
})

test('markers are read case-insensitively and past emphasis and punctuation', () => {
  assert.deepEqual(parseGoalMarker('[GOAL: done]'), { kind: 'done' })
  assert.deepEqual(parseGoalMarker('all set\n[goal: DONE].'), { kind: 'done' })
  assert.deepEqual(parseGoalMarker('**[GOAL: done]**'), { kind: 'done' })
  assert.deepEqual(parseGoalMarker('`[GOAL: continue]`'), { kind: 'continue' })
  assert.deepEqual(parseGoalMarker('[GOAL: continue]!'), { kind: 'continue' })
  // Emphasis is trimmed before punctuation, exactly as zerocode does it.
  assert.deepEqual(parseGoalMarker('`[GOAL: continue]`!'), { kind: 'missing' })
  assert.deepEqual(parseGoalMarker('[GOAL: continue]\n\n  \n'), { kind: 'continue' })
  assert.deepEqual(parseGoalMarker('[GOAL: blocked No API key]'), {
    kind: 'blocked',
    reason: 'No API key',
  })
})

test('only the last non-empty line counts', () => {
  assert.deepEqual(parseGoalMarker('[GOAL: done]\nmore text after'), { kind: 'missing' })
  assert.deepEqual(parseGoalMarker(''), { kind: 'missing' })
  assert.deepEqual(parseGoalMarker('[GOAL: finished]'), { kind: 'missing' })
})

test('history replay shows the objective, not the preamble', () => {
  assert.equal(stripGoalWrapper(goalPreamble('fix the build')), 'fix the build')
  assert.equal(stripGoalWrapper(`[context]\n\n${goalPreamble('a\n\nb')}`), 'a\n\nb')
  assert.equal(stripGoalWrapper(goalContinuation()), 'continue (goal turn)')
  assert.equal(stripGoalWrapper('an ordinary prompt'), null)

  const state = loadHistory(fresh(), [
    { role: 'user', content: goalPreamble('fix the build'), kind: 'message' },
    { role: 'assistant', content: 'working\n[GOAL: continue]', kind: 'message' },
    { role: 'user', content: goalContinuation(), kind: 'message' },
  ])
  const users = state.entries.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : ''))
  assert.deepEqual(users, ['fix the build', 'continue (goal turn)'])
})

// ── Modes ────────────────────────────────────────────────────────────

test('the cycle goes build, plan, goal, and skips plan where it is not enforced', () => {
  assert.equal(nextMode('build', 'unknown'), 'plan')
  assert.equal(nextMode('plan', 'supported'), 'goal')
  assert.equal(nextMode('goal', 'supported'), 'build')
  assert.equal(nextMode('build', 'unsupported'), 'goal')
  assert.equal(nextMode('goal', 'unsupported'), 'build')
})

test('goal runs the agent in build mode, so only plan changes reach the daemon', () => {
  assert.equal(wireMode('goal'), 'build')
  assert.equal(modeChangeNeedsDaemon('build', 'goal'), false)
  assert.equal(modeChangeNeedsDaemon('goal', 'build'), false)
  assert.equal(modeChangeNeedsDaemon('build', 'plan'), true)
  assert.equal(modeChangeNeedsDaemon('plan', 'goal'), true)
  assert.equal(parseMode(' Plan '), 'plan')
  assert.equal(parseMode('yolo'), null)
})

// ── The loop ─────────────────────────────────────────────────────────

test('the first submission in goal mode becomes the objective', () => {
  const { state, sent } = beginGoal(fresh(), 'ship the parser')
  const user = state.entries.find((e) => e.kind === 'user')
  assert.equal(user?.kind === 'user' && user.text, 'ship the parser', 'the transcript shows what was typed')
  assert.ok(sent.includes('[GOAL: done]'), 'the marker contract is sent')
  assert.ok(sent.endsWith('Objective:\nship the parser'))
  assert.deepEqual(state.goal, { objective: 'ship the parser', turn: 1, max: GOAL_MAX_TURNS, next: null })
  assert.equal(state.phase, 'working')
})

test('a continue marker arms the next turn, which the app then sends', () => {
  let state = beginGoal(fresh(), 'do it').state
  state = complete(applyUpdate(state, reply('working\n[GOAL: continue]')))
  assert.equal(state.goal?.next, 'continue')
  assert.equal(state.phase, 'idle')

  const step = continueGoal(state)
  assert.ok(step)
  assert.equal(step.sent, goalContinuation())
  assert.equal(step.state.goal?.turn, 2)
  assert.equal(step.state.goal?.next, null)
  const last = step.state.entries.at(-1)
  assert.equal(last?.kind === 'user' && last.text, 'continue (goal turn 2/10)')
  assert.equal(continueGoal(step.state), null, 'a step cannot be taken twice')
})

test('a missing marker keeps going, so the cap is what ends it', () => {
  let state = beginGoal(fresh(), 'do it').state
  state = complete(applyUpdate(state, reply('I did some of it.')))
  assert.equal(state.goal?.next, 'continue')
})

test('a done marker stops the loop and says so', () => {
  let state = beginGoal(fresh(), 'do it').state
  state = complete(applyUpdate(state, reply('all finished.\n[GOAL: done]')))
  assert.equal(state.goal, null)
  assert.equal(state.mode, 'goal', 'the mode stays, so the next message is a new objective')
  assert.ok(notices(state).some((t) => t === 'Goal reported done after 1 turn.'))
})

test('a blocked marker stops the loop and keeps the reason', () => {
  let state = beginGoal(fresh(), 'do it').state
  state = complete(applyUpdate(state, reply('[GOAL: blocked needs a password]')))
  assert.equal(state.goal, null)
  assert.ok(notices(state).includes('Goal blocked: needs a password'))
})

test('the loop stops at the turn cap', () => {
  let state = beginGoal(fresh(), 'do it').state
  state = { ...state, goal: { objective: 'do it', turn: GOAL_MAX_TURNS, max: GOAL_MAX_TURNS, next: null } }
  state = complete(applyUpdate(state, reply('[GOAL: continue]')))
  assert.equal(state.goal, null)
  assert.ok(notices(state).some((t) => t.includes(`after ${GOAL_MAX_TURNS} turns`)))
})

test('cancelled and failed turns stop the loop', () => {
  for (const outcome of ['cancelled', 'failed'] as const) {
    const state = complete(beginGoal(fresh(), 'do it').state, outcome, `turn ${outcome}`)
    assert.equal(state.goal, null, `${outcome} must not continue`)
    assert.equal(continueGoal(state), null)
  }
})

test('a stale turn_complete cannot step the goal', () => {
  let state = beginGoal(fresh(), 'do it').state
  const stale = state.generation
  state = complete(applyUpdate(state, reply('[GOAL: continue]')))
  const step = continueGoal(state)
  assert.ok(step)
  state = step.state
  const after = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: '[GOAL: done]',
    client_turn_generation: stale,
  })
  assert.equal(after, state, 'the running goal turn is untouched')
})

test('the marker is read from this turn, not an earlier one', () => {
  let state = beginGoal(fresh(), 'do it').state
  state = complete(applyUpdate(state, reply('[GOAL: continue]')))
  state = continueGoal(state)?.state ?? state
  // This turn wrote nothing; the old "continue" must not be reread, and the
  // daemon's final content is used instead.
  state = complete(state, 'completed', 'wrapped up\n[GOAL: done]')
  assert.equal(state.goal, null)
})

test('leaving goal mode ends a run, and stopping one says why', () => {
  const running = beginGoal(fresh(), 'do it').state
  const left = withMode(running, 'build')
  assert.equal(left.goal, null)
  assert.ok(notices(left).includes('Goal stopped: switched to build mode.'))

  const stopped = stopGoal(running, 'Goal stopped: you stopped it.')
  assert.equal(stopped.goal, null)
  assert.equal(stopGoal(stopped, 'again'), stopped, 'stopping nothing changes nothing')
})

test('an ordinary turn in build mode is untouched by the goal logic', () => {
  __resetIds()
  let state = startTurn(createSession({ sessionId: 's1', agentAlias: 'coder', workspaceDir: '/repo' }), 'hi')
  state = complete(applyUpdate(state, reply('[GOAL: continue]')))
  assert.equal(state.goal, null)
  assert.equal(state.phase, 'idle')
})
