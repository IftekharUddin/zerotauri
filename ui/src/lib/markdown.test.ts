import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { langOf, renderMarkdown, safeHref, textOf } from './markdown.ts'

const html = (source: string): string =>
  renderToStaticMarkup(createElement('div', null, renderMarkdown(source)))

test('headings, emphasis and inline code become elements', () => {
  const out = html('## Plan\n\nUse **bold**, *italic* and `code` here.')
  assert.ok(out.includes('<h2>Plan</h2>'), out)
  assert.ok(out.includes('<strong>bold</strong>'))
  assert.ok(out.includes('<em>italic</em>'))
  assert.ok(out.includes('<code class="inline">code</code>'))
})

test('a fenced block keeps its text whole and names its language', () => {
  const out = html('Before\n\n```rust\nfn main() {\n    println!("hi");\n}\n```\n\nAfter')
  assert.ok(
    out.includes(
      '<pre class="code" data-lang="rust"><code>fn main() {\n    println!(&quot;hi&quot;);\n}</code></pre>',
    ),
    out,
  )
  assert.ok(out.includes('<p>Before</p>') && out.includes('<p>After</p>'))
})

test('a fence without a language, or left open, still renders as code', () => {
  assert.ok(html('```\nx = 1\n```').includes('<pre class="code"><code>x = 1</code></pre>'))
  const open = html('Working:\n\n```sh\nnpm test')
  assert.ok(open.includes('<pre class="code" data-lang="sh"><code>npm test</code></pre>'), open)
})

test('lists nest, number and tick', () => {
  const out = html('- a\n  - b\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo')
  assert.ok(/<ul>\s*<li>a\s*<ul>\s*<li>b<\/li>/.test(out.replace(/\n/g, '')), out)
  assert.ok(out.includes('<ol start="3">'))
  const boxes = out.match(/<input [^>]*>/g) ?? []
  assert.equal(boxes.length, 2, out)
  assert.ok(boxes[0]?.includes('type="checkbox"') && boxes[0].includes('checked=""'), boxes[0])
  assert.ok(boxes[1]?.includes('type="checkbox"') && !boxes[1].includes('checked'), boxes[1])
  for (const box of boxes) assert.ok(/readonly=""/i.test(box), 'a task box is a fact, not a control')
  assert.ok(out.includes('<li class="task-list-item">'))
})

test('tables get a scrolling wrapper', () => {
  const out = html('| name | value |\n|---|---|\n| a | 1 |')
  assert.ok(out.includes('<div class="table-wrap"><table>'), out)
  assert.ok(out.includes('<th>name</th>') && out.includes('<td>1</td>'))
})

test('quotes, rules and strikethrough', () => {
  const out = html('> careful\n\n---\n\n~~gone~~ stays')
  assert.ok(out.includes('<blockquote>'))
  assert.ok(out.includes('<hr/>'))
  assert.ok(out.includes('<del>gone</del>'))
})

test('raw html is shown as the text it is, never interpreted', () => {
  const out = html('Use <name> here, <b>not bold</b>, and <script>alert(1)</script>.')
  assert.ok(out.includes('&lt;name&gt;'), out)
  assert.ok(out.includes('&lt;b&gt;not bold&lt;/b&gt;'))
  assert.ok(!out.includes('<b>') && !out.includes('<script>'))
})

test('a link is live only for http and https, and never navigates the window', () => {
  const out = html('[site](https://example.com/a?b=1) [bad](javascript:alert(1)) [ftp](ftp://x/y)')
  assert.ok(
    out.includes('<a href="https://example.com/a?b=1" class="link" title="https://example.com/a?b=1">site</a>'),
    out,
  )
  assert.ok(out.includes('<span class="link dead">bad</span>'))
  assert.ok(out.includes('<span class="link dead">ftp</span>'))
  const bare = html('see https://example.org/path.')
  assert.ok(bare.includes('href="https://example.org/path"'), bare)
})

test('an image becomes its description and address', () => {
  const out = html('![diagram](https://host/x.png)')
  assert.ok(!out.includes('<img'), out)
  assert.ok(out.includes('<span class="image">diagram <span class="mono">https://host/x.png</span></span>'))
})

test('identifiers with underscores are not emphasis', () => {
  const out = html('call snake_case_name(some_arg) then run_it')
  assert.ok(!out.includes('<em>'), out)
})

test('safe addresses are absolute http or https with nothing odd in them', () => {
  assert.equal(safeHref('https://example.com'), 'https://example.com/')
  assert.equal(safeHref('  HTTP://Example.com/p  '), 'http://example.com/p')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('file:///etc/passwd'), null)
  assert.equal(safeHref('/relative'), null)
  assert.equal(safeHref('https://a b'), null)
  assert.equal(safeHref('https://x\n'), 'https://x/')
  assert.equal(safeHref(`https://${'a'.repeat(3000)}`), null)
  assert.equal(safeHref(42), null)
})

test('node helpers read text and language from a rendered node', () => {
  const code = {
    type: 'element',
    tagName: 'code',
    properties: { className: ['language-TS'] },
    children: [{ type: 'text', value: 'let x' }, { type: 'text', value: ' = 1\n' }],
  }
  assert.equal(textOf(code), 'let x = 1\n')
  assert.equal(langOf(code), 'ts')
  assert.equal(langOf({ type: 'element', tagName: 'code' }), null)
  assert.equal(textOf(undefined), '')
})
