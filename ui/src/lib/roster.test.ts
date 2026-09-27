import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NO_PARKED, liveMarks, park, routeParked, unpark, updateParked, without } from './roster.ts'
import { __resetIds, applyUpdate, createSession, startTurn, type SessionState } from './session.ts'
import type { SessionUpdate } from './types.ts'

const session = (id: string): SessionState => {
  __resetIds()
  return createSession({ sessionId: id, agentAlias: 'coder', workspaceDir: `/repo/${id}` })
}

const chunk = (id: string, text: string): SessionUpdate => ({
  type: 'agent_message_chunk',
  session_id: id,
  text,
})

test('an event reaches the parked session it belongs to, and no other', () => {
  const a = startTurn(session('a'), 'go')
  const b = session('b')
  let parked = park(park(NO_PARKED, a), b)
  parked = routeParked(parked, chunk('a', 'hello'))
  const reply = parked.get('a')?.entries.find((e) => e.kind === 'assistant')
  assert.equal(reply?.kind === 'assistant' && reply.text, 'hello')
  assert.equal(parked.get('b'), b, 'b is untouched')
  assert.equal(routeParked(parked, chunk('nobody', 'x')), parked, 'an unknown session changes nothing')
})

test('parking, unparking and dropping keep the map immutable', () => {
  const a = session('a')
  const one = park(NO_PARKED, a)
  assert.equal(NO_PARKED.size, 0)
  const taken = unpark(one, 'a')
  assert.ok(taken)
  assert.equal(taken.session, a)
  assert.equal(taken.parked.size, 0)
  assert.equal(one.size, 1, 'the original map is unchanged')
  assert.equal(unpark(one, 'zzz'), null)
  assert.equal(without(one, 'zzz'), one)
  assert.equal(without(one, 'a').size, 0)
})

test('a parked session can be changed in place', () => {
  const parked = park(NO_PARKED, session('a'))
  const next = updateParked(parked, 'a', (s) => ({ ...s, branch: 'main' }))
  assert.equal(next.get('a')?.branch, 'main')
  assert.equal(updateParked(parked, 'a', (s) => s), parked, 'no change, same map')
  assert.equal(updateParked(parked, 'nobody', (s) => ({ ...s, branch: 'x' })), parked)
})

test('the rail is told which open sessions are busy or waiting on an approval', () => {
  const running = startTurn(session('a'), 'go')
  const waiting = applyUpdate(startTurn(session('b'), 'go'), {
    type: 'approval_request',
    session_id: 'b',
    request_id: 'r1',
    tool_name: 'shell',
    arguments_summary: 'rm x',
    timeout_secs: 120,
  })
  const idle = session('c')
  const marks = liveMarks(idle, park(park(NO_PARKED, running), waiting))
  assert.deepEqual(marks.get('a'), { busy: true, approval: false })
  assert.deepEqual(marks.get('b'), { busy: true, approval: true })
  assert.deepEqual(marks.get('c'), { busy: false, approval: false })
  assert.equal(marks.has('d'), false)
})
