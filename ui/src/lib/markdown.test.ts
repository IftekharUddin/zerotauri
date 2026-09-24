import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseBlocks, splitInline } from './markdown.ts'

test('a fenced block is separated from surrounding prose', () => {
  const blocks = parseBlocks('before\n```ts\nconst a = 1\n```\nafter')
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['text', 'code', 'text'],
  )
  assert.equal(blocks[1]?.text, 'const a = 1')
  assert.equal(blocks[1]?.lang, 'ts')
})

test('an unterminated fence still renders as code', () => {
  const blocks = parseBlocks('```\nhalf a block')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind, 'code')
})

test('blank prose is dropped but blank code is kept', () => {
  assert.equal(parseBlocks('\n\n   \n').length, 0)
  assert.equal(parseBlocks('```\n\n```').length, 1)
})

test('plain prose stays one text block', () => {
  const blocks = parseBlocks('just a sentence')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind, 'text')
})

test('inline code spans are separated from prose', () => {
  const spans = splitInline('call `fetch()` twice')
  assert.deepEqual(
    spans.map((s) => [s.code, s.text]),
    [
      [false, 'call '],
      [true, 'fetch()'],
      [false, ' twice'],
    ],
  )
})

test('text with no backticks stays a single plain span', () => {
  assert.deepEqual(splitInline('nothing special'), [{ code: false, text: 'nothing special' }])
})
