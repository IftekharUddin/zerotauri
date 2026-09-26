import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  NO_OVERRIDES,
  applyConfigureEcho,
  configureFailureText,
  deriveCaps,
  describeChange,
  effectiveIdentity,
  effortAdjustable,
  effortUnavailable,
  isRpcFailure,
} from './overrides.ts'
import { __resetIds, createSession, type SessionState } from './session.ts'
import type { Configured, ConnectionInfo, SessionOverrides, ThinkingOptions } from './types.ts'

const info = (missingMethods: string[]): ConnectionInfo => ({
  endpoint: '/tmp/zc/data/daemon.sock',
  configDir: '/tmp/zc',
  serverVersion: '0.8.5',
  serverPid: 42,
  protocolVersion: 1,
  startedByApp: false,
  missingMethods,
})

const fresh = (): SessionState => {
  __resetIds()
  return createSession({
    sessionId: 's1',
    agentAlias: 'coder',
    workspaceDir: '/repo',
    identity: { provider: 'anthropic.default', model: 'claude-opus-4-8' },
  })
}

const echo = (overrides: Partial<SessionOverrides>, droppedFields: string[] = []): Configured => ({
  sessionId: 's1',
  overrides: { ...NO_OVERRIDES, ...overrides },
  thinkingOptions: null,
  droppedFields,
})

test('capabilities follow what the daemon says it is missing', () => {
  const caps = deriveCaps(info(['session/thinking-options', 'config/catalog-models']))
  assert.equal(caps.configure, true)
  assert.equal(caps.catalog, false)
  assert.equal(caps.providers, true)
  assert.equal(caps.thinkingOptions, false)
})

test('an empty missing list offers everything, and no connection offers nothing', () => {
  assert.deepEqual(Object.values(deriveCaps(info([]))), [true, true, true, true, true])
  assert.deepEqual(Object.values(deriveCaps(null)), [false, false, false, false, false])
})

test('a model echo becomes the override and the shown model', () => {
  const state = applyConfigureEcho(fresh(), { model: 'claude-fable-5-1' }, echo({ model: 'claude-fable-5-1' }))
  assert.equal(state.overrides.model, 'claude-fable-5-1')
  assert.deepEqual(effectiveIdentity(state), {
    provider: 'anthropic.default',
    model: 'claude-fable-5-1',
  })
})

test('a provider switch without a model leaves the model unknown until it is read', () => {
  const start = applyConfigureEcho(fresh(), { model: 'm-old' }, echo({ model: 'm-old' }))
  const state = applyConfigureEcho(
    start,
    { modelProvider: 'openai.work' },
    // The daemon clears the model override when the provider changes alone.
    echo({ modelProvider: 'openai.work' }),
  )
  assert.equal(state.overrides.model, null)
  assert.deepEqual(effectiveIdentity(state), { provider: 'openai.work', model: null })
})

test('re-selecting the current provider keeps the known default model', () => {
  const state = applyConfigureEcho(
    fresh(),
    { modelProvider: 'anthropic.default' },
    echo({ modelProvider: 'anthropic.default' }),
  )
  assert.equal(effectiveIdentity(state).model, 'claude-opus-4-8')
})

test('an echo for another session changes nothing', () => {
  const state = fresh()
  const after = applyConfigureEcho(state, { model: 'x' }, { ...echo({ model: 'x' }), sessionId: 's2' })
  assert.equal(after, state)
})

test('an override always wins over the configured identity', () => {
  const state = { ...fresh(), overrides: { ...NO_OVERRIDES, modelProvider: 'ollama.local' } }
  assert.deepEqual(effectiveIdentity(state), { provider: 'ollama.local', model: 'claude-opus-4-8' })
})

test('the transcript records provider and model changes in words', () => {
  assert.equal(
    describeChange({ modelProvider: 'openai.work' }, echo({ modelProvider: 'openai.work' })),
    'Provider set to openai.work, on its configured model.',
  )
  assert.equal(
    describeChange({ model: 'gpt-5' }, echo({ model: 'gpt-5' })),
    'Model set to gpt-5.',
  )
  assert.equal(describeChange({ temperature: 0.2 }, echo({ temperature: 0.2 })), null)
})

const thinking = (change: Partial<ThinkingOptions> = {}): ThinkingOptions => ({
  modelProvider: 'anthropic.default',
  model: 'claude-fable-5-1',
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  displays: ['omitted', 'summarized'],
  currentLevel: 'medium',
  levelSource: 'profile',
  currentDisplay: 'omitted',
  displaySource: 'model_default',
  ...change,
})

test('a thinking report in the echo becomes the session identity and options', () => {
  const state = applyConfigureEcho(fresh(), { model: 'claude-fable-5-1' }, {
    ...echo({ model: 'claude-fable-5-1' }),
    thinkingOptions: thinking(),
  })
  assert.deepEqual(state.identity, { provider: 'anthropic.default', model: 'claude-fable-5-1' })
  assert.equal(state.thinking?.currentLevel, 'medium')
  assert.equal(effortAdjustable(state), true)
})

test('a model with empty lists hides the thinking controls', () => {
  const state = applyConfigureEcho(fresh(), { model: 'gpt-5' }, {
    ...echo({ model: 'gpt-5' }),
    thinkingOptions: thinking({ model: 'gpt-5', levels: [], displays: [], currentLevel: null }),
  })
  assert.equal(effortAdjustable(state), false)
  assert.match(effortUnavailable(state, deriveCaps(info([]))), /gpt-5 has no reasoning effort/)
  assert.match(effortUnavailable(fresh(), deriveCaps(info(['session/thinking-options']))), /cannot set/)
})

test('a model change clears the thinking overrides the daemon cleared', () => {
  const tuned = applyConfigureEcho(fresh(), { thinkingLevel: 'high' }, {
    ...echo({ thinkingLevel: 'high' }),
    thinkingOptions: thinking({ currentLevel: 'high', levelSource: 'session' }),
  })
  assert.equal(tuned.overrides.thinkingLevel, 'high')
  const switched = applyConfigureEcho(tuned, { model: 'claude-opus-4-6' }, {
    ...echo({ model: 'claude-opus-4-6' }),
    thinkingOptions: thinking({ model: 'claude-opus-4-6', levels: ['low', 'medium', 'high', 'max'] }),
  })
  assert.equal(switched.overrides.thinkingLevel, null)
  assert.deepEqual(switched.thinking?.levels, ['low', 'medium', 'high', 'max'])
})

test('thinking changes and resets read in words', () => {
  const withOptions = (o: Partial<SessionOverrides>, t: Partial<ThinkingOptions> = {}) => ({
    ...echo(o),
    thinkingOptions: thinking(t),
  })
  assert.equal(
    describeChange({ thinkingLevel: 'high' }, withOptions({ thinkingLevel: 'high' })),
    'Reasoning effort set to high.',
  )
  assert.equal(
    describeChange({}, withOptions({}, { currentLevel: 'medium' }), ['thinking_level']),
    'Reasoning effort back to the default, now medium.',
  )
  assert.equal(
    describeChange({ thinkingDisplay: 'summarized' }, withOptions({ thinkingDisplay: 'summarized' })),
    'Thinking display set to summarized.',
  )
})

test('a refused value keeps the daemon text, which names what it accepts', () => {
  const refusal = { code: -32602, message: 'model_provider must not be blank', userMessage: 'x' }
  assert.equal(isRpcFailure(refusal), true)
  assert.match(configureFailureText(refusal), /must not be blank/)
  assert.match(configureFailureText('socket closed'), /socket closed/)
  assert.equal(isRpcFailure('socket closed'), false)
})
