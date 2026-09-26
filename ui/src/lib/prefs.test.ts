import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NO_OVERRIDES } from './overrides.ts'
import {
  SETTINGS_MAX_AGE_MS,
  describeRestore,
  forgetSettings,
  loadSettings,
  patchMatches,
  pruneSettings,
  reapplyPlan,
  settingsFromOverrides,
  settingsKey,
  updateSettings,
  type SavedSettings,
  type Store,
} from './prefs.ts'

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    keys: () => [...data.keys()],
  }
}

const EP = '/tmp/zc/data/daemon.sock'

const saved = (change: Partial<SavedSettings>): SavedSettings => ({
  model: null,
  modelProvider: null,
  temperature: null,
  thinkingLevel: null,
  thinkingDisplay: null,
  mode: 'build',
  savedAt: 1,
  ...change,
})

test('settings are scoped by endpoint and session', () => {
  const store = memory()
  updateSettings(store, EP, 's1', { model: 'm1' })
  updateSettings(store, '/other/daemon.sock', 's1', { model: 'm2' })
  assert.equal(loadSettings(store, EP, 's1')?.model, 'm1')
  assert.equal(loadSettings(store, '/other/daemon.sock', 's1')?.model, 'm2')
  assert.equal(loadSettings(store, EP, 's2'), null)
  assert.notEqual(settingsKey(EP, 's1'), settingsKey('/other/daemon.sock', 's1'))
})

test('a change merges into what is stored and round-trips every field', () => {
  const store = memory()
  updateSettings(store, EP, 's1', { modelProvider: 'anthropic.default', model: 'm1' }, 10)
  updateSettings(store, EP, 's1', { mode: 'plan', thinkingLevel: 'high', temperature: 0.2 }, 20)
  assert.deepEqual(loadSettings(store, EP, 's1'), {
    model: 'm1',
    modelProvider: 'anthropic.default',
    temperature: 0.2,
    thinkingLevel: 'high',
    thinkingDisplay: null,
    mode: 'plan',
    savedAt: 20,
  })
})

test('settings back at every default are removed rather than stored', () => {
  const store = memory()
  updateSettings(store, EP, 's1', { mode: 'goal' })
  assert.equal(store.data.size, 1)
  updateSettings(store, EP, 's1', { mode: 'build' })
  assert.equal(store.data.size, 0)
})

test('corrupt or foreign data reads as nothing, and a bad mode reads as build', () => {
  const store = memory()
  store.setItem(settingsKey(EP, 's1'), '{not json')
  assert.equal(loadSettings(store, EP, 's1'), null)
  store.setItem(settingsKey(EP, 's2'), JSON.stringify({ model: 7, mode: 'yolo', modelProvider: 'x.y' }))
  const odd = loadSettings(store, EP, 's2')
  assert.equal(odd?.model, null)
  assert.equal(odd?.mode, 'build')
  assert.equal(odd?.modelProvider, 'x.y')
  assert.equal(loadSettings(null, EP, 's1'), null)
})

test('forgetting and pruning remove only what they should', () => {
  const store = memory()
  updateSettings(store, EP, 'old', { model: 'm' }, 0)
  updateSettings(store, EP, 'new', { model: 'm' }, SETTINGS_MAX_AGE_MS)
  store.setItem('unrelated', 'keep me')
  assert.equal(pruneSettings(store, SETTINGS_MAX_AGE_MS + 1), 1)
  assert.equal(loadSettings(store, EP, 'old'), null)
  assert.equal(loadSettings(store, EP, 'new')?.model, 'm')
  assert.equal(store.getItem('unrelated'), 'keep me')
  forgetSettings(store, EP, 'new')
  assert.equal(loadSettings(store, EP, 'new'), null)
})

test('the stored subset of an echo leaves mode to the app', () => {
  const change = settingsFromOverrides({ ...NO_OVERRIDES, model: 'm1', mode: 'plan' })
  assert.equal(change.model, 'm1')
  assert.equal('mode' in change, false)
})

test('a re-apply sends thinking fields only to a daemon with thinking controls', () => {
  const s = saved({ model: 'm1', thinkingLevel: 'high', thinkingDisplay: 'summarized' })
  assert.deepEqual(reapplyPlan(s, { thinking: false, planSupport: 'unknown' }).patch, { model: 'm1' })
  assert.deepEqual(reapplyPlan(s, { thinking: true, planSupport: 'unknown' }).patch, {
    model: 'm1',
    thinkingLevel: 'high',
    thinkingDisplay: 'summarized',
  })
})

test('a re-apply skips plan mode where the daemon is known not to enforce it', () => {
  assert.equal(reapplyPlan(saved({ mode: 'plan' }), { thinking: false, planSupport: 'unknown' }).mode, 'plan')
  assert.equal(
    reapplyPlan(saved({ mode: 'plan' }), { thinking: false, planSupport: 'unsupported' }).mode,
    'build',
  )
})

test('goal and build modes re-apply without any daemon call', () => {
  const plan = reapplyPlan(saved({ mode: 'goal' }), { thinking: true, planSupport: 'supported' })
  assert.equal(plan.patch, null)
  assert.equal(plan.mode, 'goal')
})

test('a provider-only setting never carries a stale model', () => {
  // A provider switch without a model is echoed with no model, and only the
  // echo is stored.
  const store = memory()
  updateSettings(store, EP, 's1', settingsFromOverrides({ ...NO_OVERRIDES, model: 'old-model' }))
  updateSettings(
    store,
    EP,
    's1',
    settingsFromOverrides({ ...NO_OVERRIDES, modelProvider: 'openai.work' }),
  )
  const s = loadSettings(store, EP, 's1')
  assert.ok(s)
  assert.deepEqual(reapplyPlan(s, { thinking: false, planSupport: 'unknown' }).patch, {
    modelProvider: 'openai.work',
  })
})

test('a patch the daemon already holds is recognised, and restores read in words', () => {
  const overrides = { ...NO_OVERRIDES, model: 'm1', thinkingLevel: 'high' }
  assert.equal(patchMatches({ model: 'm1', thinkingLevel: 'high' }, overrides), true)
  assert.equal(patchMatches({ model: 'm2' }, overrides), false)
  assert.equal(
    describeRestore({ modelProvider: 'anthropic.default', model: 'm1', thinkingLevel: 'high' }),
    "Restored this session's settings: provider anthropic.default, model m1, effort high.",
  )
})

test('a restore notice never claims a setting the daemon dropped', () => {
  assert.equal(
    describeRestore({ model: 'm1', thinkingLevel: 'high' }, ['thinking_level']),
    "Restored this session's settings: model m1. This daemon ignored: effort high.",
  )
  assert.equal(
    describeRestore({ thinkingLevel: 'high' }, ['thinking_level']),
    "None of this session's saved settings could be restored. This daemon ignored: effort high.",
  )
})
