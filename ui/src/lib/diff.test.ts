import assert from 'node:assert/strict'
import { test } from 'node:test'

import { changeFromTool, diffLines } from './diff.ts'

test('an unchanged file produces no add or remove lines', () => {
  const { lines } = diffLines('a\nb\nc', 'a\nb\nc')
  assert.equal(lines.filter((l) => l.tag !== 'context').length, 0)
})

test('a replaced line shows one removal and one addition', () => {
  const { lines } = diffLines('a\nb\nc', 'a\nB\nc')
  assert.deepEqual(
    lines.filter((l) => l.tag !== 'context').map((l) => [l.tag, l.text]),
    [
      ['remove', 'b'],
      ['add', 'B'],
    ],
  )
})

test('pure insertion is reported as additions only', () => {
  const { lines } = diffLines('a\nc', 'a\nb\nc')
  const changed = lines.filter((l) => l.tag !== 'context')
  assert.deepEqual(changed.map((l) => l.tag), ['add'])
  assert.equal(changed[0]?.text, 'b')
})

test('distant unchanged regions collapse to an ellipsis', () => {
  const before = ['x', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'y'].join('\n')
  const after = ['X', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'y'].join('\n')
  const { lines } = diffLines(before, after)
  assert.ok(lines.some((l) => l.text === '…'), 'expected collapsed context')
  assert.ok(lines.length < 20, `expected a compact diff, got ${lines.length} lines`)
})

test('file_edit tool input becomes a change with counts', () => {
  const change = changeFromTool({
    name: 'file_edit',
    input: { path: 'src/fetch.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
  })
  assert.ok(change)
  assert.equal(change.path, 'src/fetch.ts')
  assert.equal(change.mode, 'edit')
  assert.equal(change.added, 1)
  assert.equal(change.removed, 1)
})

test('file_write tool input becomes an all-added change', () => {
  const change = changeFromTool({
    name: 'file_write',
    input: { path: 'new.txt', content: 'one\ntwo\nthree' },
  })
  assert.ok(change)
  assert.equal(change.mode, 'write')
  assert.equal(change.added, 3)
  assert.equal(change.removed, 0)
})

test('a non-file tool yields no change', () => {
  assert.equal(changeFromTool({ name: 'shell', input: { command: 'npm test' } }), null)
  assert.equal(changeFromTool({ name: 'file_edit', input: { path: 'x' } }), null)
})

test('an oversized edit is truncated rather than diffed line by line', () => {
  const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n')
  const { truncated } = diffLines(big, `${big}\nextra`)
  assert.equal(truncated, true)
})
