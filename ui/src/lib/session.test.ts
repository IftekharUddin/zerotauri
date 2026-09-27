import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  __resetIds,
  applyUpdate,
  createSession,
  loadHistory,
  pushNotice,
  startTurn,
  type SessionState,
} from './session.ts'
import type { SessionUpdate } from './types.ts'

const fresh = (): SessionState => {
  __resetIds()
  return createSession({ sessionId: 's1', agentAlias: 'coder', workspaceDir: '/repo' })
}

const chunk = (text: string): SessionUpdate => ({
  type: 'agent_message_chunk',
  session_id: 's1',
  text,
})

test('streamed chunks coalesce into one assistant entry', () => {
  let state = startTurn(fresh(), 'do the thing')
  state = applyUpdate(state, chunk('Hello'))
  state = applyUpdate(state, chunk(', world'))

  const assistant = state.entries.filter((e) => e.kind === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0]?.kind === 'assistant' && assistant[0].text, 'Hello, world')
  assert.equal(state.phase, 'responding')
})

test('an update for another session is ignored', () => {
  const state = startTurn(fresh(), 'hi')
  const other = applyUpdate(state, { type: 'agent_message_chunk', session_id: 'other', text: 'x' })
  assert.equal(other, state)
})

test('an unknown event type leaves the state untouched', () => {
  const state = startTurn(fresh(), 'hi')
  const after = applyUpdate(state, { type: 'something_new_in_a_later_daemon', session_id: 's1' })
  assert.equal(after, state)
})

test('turn_complete is what settles a turn', () => {
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, chunk('partial'))
  assert.notEqual(state.phase, 'idle')

  state = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: 'partial',
    client_turn_generation: state.generation,
  })

  assert.equal(state.phase, 'idle')
  const assistant = state.entries.find((e) => e.kind === 'assistant')
  assert.equal(assistant?.kind === 'assistant' && assistant.streaming, false)
})

test('a stale turn_complete cannot settle a newer turn', () => {
  let state = startTurn(fresh(), 'first')
  const staleGeneration = state.generation
  state = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: '',
    client_turn_generation: staleGeneration,
  })
  state = startTurn(state, 'second')
  assert.equal(state.phase, 'working')

  const after = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: 'from the old turn',
    client_turn_generation: staleGeneration,
  })

  assert.equal(after.phase, 'working', 'the newer turn must still be running')
  assert.equal(after, state)
})

test('a legacy turn_complete without a generation still settles the turn', () => {
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: 'done',
  })
  assert.equal(state.phase, 'idle')
})

test('a cancelled turn records the daemon reason and clears the approval', () => {
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, {
    type: 'approval_request',
    session_id: 's1',
    request_id: 'r1',
    tool_name: 'shell',
    arguments_summary: 'npm test',
    timeout_secs: 120,
  })
  assert.equal(state.phase, 'awaiting-approval')
  assert.equal(state.pendingApproval?.requestId, 'r1')

  state = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'cancelled',
    content: 'turn cancelled via client_rpc',
    client_turn_generation: state.generation,
  })

  assert.equal(state.phase, 'idle')
  assert.equal(state.pendingApproval, null)
  const notice = state.entries.find((e) => e.kind === 'notice')
  assert.ok(notice?.kind === 'notice' && notice.text.includes('cancelled'))
})

test('an approval deadline is derived from the daemon timeout', () => {
  const before = Date.now()
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, {
    type: 'approval_request',
    session_id: 's1',
    request_id: 'r1',
    tool_name: 'shell',
    arguments_summary: 'rm -rf build',
    timeout_secs: 120,
  })
  const deadline = state.pendingApproval?.deadline ?? 0
  assert.ok(deadline >= before + 119_000 && deadline <= Date.now() + 120_000)
})

test('a tool result attaches to its own call', () => {
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, {
    type: 'tool_call',
    session_id: 's1',
    tool_call_id: 'c1',
    name: 'read_file',
    raw_input: { path: 'a.ts' },
  })
  state = applyUpdate(state, {
    type: 'tool_call',
    session_id: 's1',
    tool_call_id: 'c2',
    name: 'shell',
    raw_input: { command: 'ls' },
  })
  state = applyUpdate(state, {
    type: 'tool_result',
    session_id: 's1',
    tool_call_id: 'c1',
    name: 'read_file',
    raw_output: 'file body',
  })

  const tools = state.entries.filter((e) => e.kind === 'tool')
  assert.equal(tools.length, 2)
  assert.equal(tools[0]?.kind === 'tool' && tools[0].output, 'file body')
  assert.equal(tools[1]?.kind === 'tool' && tools[1].output, undefined)
})

test('tool calls are tagged with the turn that produced them', () => {
  let state = startTurn(fresh(), 'first')
  state = applyUpdate(state, {
    type: 'tool_call',
    session_id: 's1',
    tool_call_id: 'c1',
    name: 'file_edit',
    raw_input: {},
  })
  state = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: '',
    client_turn_generation: state.generation,
  })
  state = startTurn(state, 'second')
  state = applyUpdate(state, {
    type: 'tool_call',
    session_id: 's1',
    tool_call_id: 'c2',
    name: 'file_edit',
    raw_input: {},
  })

  const turns = state.entries.filter((e) => e.kind === 'tool').map((e) => e.turn)
  assert.deepEqual(turns, [1, 2])
})

test('context usage keeps the last known budget when an update omits it', () => {
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, {
    type: 'context_usage',
    session_id: 's1',
    input_tokens: 100,
    max_context_tokens: 200_000,
  })
  state = applyUpdate(state, { type: 'context_usage', session_id: 's1', input_tokens: 150 })
  assert.equal(state.contextInput, 150)
  assert.equal(state.contextMax, 200_000)
})

test('a plan update replaces the whole list', () => {
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, {
    type: 'plan',
    session_id: 's1',
    entries: [{ content: 'one', status: 'in_progress' }],
  })
  state = applyUpdate(state, {
    type: 'plan',
    session_id: 's1',
    entries: [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'pending' },
    ],
  })
  assert.equal(state.plan.length, 2)
  assert.equal(state.plan[0]?.status, 'completed')
})

test('history replay pairs tool calls with their results', () => {
  const state = loadHistory(fresh(), [
    { role: 'user', content: 'add retry', kind: 'message' },
    {
      role: 'assistant',
      content: '',
      kind: 'tool_call',
      tool_call_id: 'c1',
      tool_name: 'file_edit',
      tool_input: { path: 'a.ts' },
    },
    {
      role: 'tool',
      content: 'ok',
      kind: 'tool_result',
      tool_call_id: 'c1',
      tool_name: 'file_edit',
      tool_output: 'edited',
    },
    { role: 'assistant', content: 'Done.', kind: 'message' },
  ])

  const kinds = state.entries.map((e) => e.kind)
  assert.deepEqual(kinds, ['user', 'tool', 'assistant'])
  const tool = state.entries.find((e) => e.kind === 'tool')
  assert.equal(tool?.kind === 'tool' && tool.output, 'edited')
})

test('history trimming surfaces a visible notice', () => {
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, {
    type: 'history_trimmed',
    session_id: 's1',
    dropped_messages: 4,
    kept_turns: 2,
    reason: 'budget',
  })
  const notice = state.entries.find((e) => e.kind === 'notice')
  assert.ok(notice?.kind === 'notice' && notice.text.includes('trimmed'))
})

test('a notice posted mid-reply does not split the reply', () => {
  let state = startTurn(fresh(), 'go')
  state = applyUpdate(state, chunk('Here is '))
  state = pushNotice(state, 'A turn is running.', 'warn')
  state = applyUpdate(state, chunk('the plan.'))
  const kinds = state.entries.map((e) => e.kind)
  assert.deepEqual(kinds, ['user', 'assistant', 'notice'])
  const reply = state.entries[1]
  assert.equal(reply?.kind === 'assistant' && reply.text, 'Here is the plan.')
})

test('a notice between turns still starts a fresh reply', () => {
  let state = startTurn(fresh(), 'first')
  state = applyUpdate(state, chunk('one'))
  state = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: 'one',
    client_turn_generation: state.generation,
  })
  state = pushNotice(state, 'Model set to m2.')
  state = startTurn(state, 'second')
  state = applyUpdate(state, chunk('two'))
  const replies = state.entries.filter((e) => e.kind === 'assistant')
  assert.equal(replies.length, 2)
})

test('a session opened mid-turn is busy, and settles on a completion it never issued', () => {
  __resetIds()
  let state = createSession({ sessionId: 's1', agentAlias: 'coder', workspaceDir: '/repo', running: true })
  assert.equal(state.phase, 'working')
  assert.equal(state.adoptedTurn, true)
  state = applyUpdate(state, chunk('rest of the reply'))
  state = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: 'done',
    client_turn_generation: 7,
  })
  assert.equal(state.phase, 'idle', 'the foreign generation is accepted once')
  assert.equal(state.adoptedTurn, false)

  state = startTurn(state, 'next')
  const after = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'completed',
    content: '',
    client_turn_generation: 7,
  })
  assert.equal(after, state, 'the fence is back for turns this window starts')
})

test('cancelling an adopted turn settles it too', () => {
  __resetIds()
  let state = createSession({ sessionId: 's1', agentAlias: 'coder', workspaceDir: '/repo', running: true })
  state = applyUpdate(state, {
    type: 'turn_complete',
    session_id: 's1',
    outcome: 'cancelled',
    content: 'turn cancelled via client_rpc',
    client_turn_generation: 3,
  })
  assert.equal(state.phase, 'idle')
  assert.ok(state.entries.some((e) => e.kind === 'notice' && e.text.includes('cancelled')))
})
