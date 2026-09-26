import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { NO_OVERRIDES } from './overrides.ts'
import { __resetIds, createSession } from './session.ts'
import { COMMANDS, findCommand, helpText, parseInput, statusText } from './slash.ts'

test('plain text is left alone', () => {
  assert.deepEqual(parseInput('fix the build'), { kind: 'text', text: 'fix the build' })
})

test('a double slash sends one literal slash', () => {
  assert.deepEqual(parseInput('//etc/hosts looks wrong'), {
    kind: 'text',
    text: '/etc/hosts looks wrong',
  })
})

test('a lone slash, or a slash then a space, is text', () => {
  assert.deepEqual(parseInput('/'), { kind: 'text', text: '/' })
  assert.deepEqual(parseInput('/ is the root'), { kind: 'text', text: '/ is the root' })
})

test('every name and alias resolves to its own command', () => {
  for (const command of COMMANDS) {
    for (const name of [command.name, ...command.aliases]) {
      const parsed = parseInput(`/${name}`)
      assert.deepEqual(parsed, { kind: 'command', name: command.name, arg: '' }, name)
    }
  }
})

test('names match without regard to case, and the rest is the argument', () => {
  assert.deepEqual(parseInput('/MODEL claude-fable-5-1'), {
    kind: 'command',
    name: 'model',
    arg: 'claude-fable-5-1',
  })
  assert.deepEqual(parseInput('/goal ship the parser\nwith tests'), {
    kind: 'command',
    name: 'goal',
    arg: 'ship the parser\nwith tests',
  })
})

test('an unknown command is reported, never sent', () => {
  assert.deepEqual(parseInput('/Users/me/repo is broken'), {
    kind: 'unknown',
    name: 'Users/me/repo',
  })
  assert.deepEqual(parseInput('/yolo'), { kind: 'unknown', name: 'yolo' })
})

test('a prefix of a command is not that command', () => {
  assert.deepEqual(parseInput('/mod plan'), { kind: 'unknown', name: 'mod' })
  assert.equal(findCommand('provider')?.name, 'provider')
  assert.equal(findCommand('model-provider')?.name, 'provider')
})

test('no two commands claim the same name', () => {
  const names = COMMANDS.flatMap((c) => [c.name, ...c.aliases])
  assert.equal(new Set(names).size, names.length)
})

test('help lists every command and the escape', () => {
  const help = helpText()
  for (const command of COMMANDS) assert.ok(help.includes(`/${command.name}`), command.name)
  assert.ok(help.includes('/model-provider'))
  assert.ok(help.includes('//'))
})

test('a leading /effort:<level> is a one-message depth, sent unchanged', () => {
  assert.deepEqual(parseInput('/effort:HIGH refactor the parser'), {
    kind: 'inline-effort',
    level: 'high',
    rest: 'refactor the parser',
    text: '/effort:HIGH refactor the parser',
  })
  assert.deepEqual(parseInput('/effort high'), { kind: 'command', name: 'effort', arg: 'high' })
  assert.deepEqual(parseInput('/think'), { kind: 'command', name: 'effort', arg: '' })
})

test('status reports effort only where the daemon can adjust it', () => {
  __resetIds()
  const base = createSession({ sessionId: 's1', agentAlias: 'coder', workspaceDir: '/repo' })
  assert.match(statusText(base, null, 'unknown'), /Reasoning effort: not adjustable on this daemon/)
  const tierC = {
    ...base,
    thinking: {
      modelProvider: 'anthropic.default',
      model: 'claude-fable-5-1',
      levels: ['low', 'medium', 'high'],
      displays: ['omitted', 'summarized'],
      currentLevel: 'high',
      levelSource: 'session',
      currentDisplay: 'summarized',
      displaySource: 'profile',
    },
  }
  const text = statusText(tierC, null, 'unknown')
  assert.match(text, /Reasoning effort: high \(set for this session; accepts low, medium, high\)/)
  assert.match(text, /Thinking display: summarized \(from the runtime profile; accepts omitted, summarized\)/)
})

test('status names where each setting comes from', () => {
  __resetIds()
  const state = {
    ...createSession({
      sessionId: 's1',
      agentAlias: 'coder',
      workspaceDir: '/repo',
      identity: { provider: 'anthropic.default', model: 'claude-opus-4-8' },
    }),
    overrides: { ...NO_OVERRIDES, model: 'claude-fable-5-1' },
  }
  const text = statusText(state, null, 'unsupported')
  assert.match(text, /Provider: anthropic\.default \(configured default\)/)
  assert.match(text, /Model: claude-fable-5-1 \(set for this session\)/)
  assert.match(text, /Mode: build \(this daemon does not enforce plan mode\)/)
})

test('the README documents every command and alias', () => {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  for (const command of COMMANDS) {
    for (const name of [command.name, ...command.aliases]) {
      assert.ok(readme.includes(`\`/${name}`), `README is missing /${name}`)
    }
  }
})
