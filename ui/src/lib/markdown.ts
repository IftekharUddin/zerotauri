// Transcript Markdown, rendered to React elements and nothing else.
//
// Transcript text is untrusted: it comes from a model and from repository
// content the model read. So raw HTML is shown as the text it is, never
// interpreted. A link never navigates this window: on a click it is handed
// to the system browser, and only when it is http or https. An image is
// shown as its description and address, since nothing remote may load here.
// GitHub-flavoured tables, task lists and strikethrough are understood,
// because that is what models write.

import { createElement, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** How a clicked link leaves the window. The app sets it; tests leave it inert. */
let openLink: (url: string) => void = () => {}

export function setLinkOpener(fn: (url: string) => void): void {
  openLink = fn
}

/** Longest address a click may open. */
export const LINK_MAX = 2048

/** An address a click may open: absolute http or https, nothing else. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const text = href.trim()
  if (text.length === 0 || text.length > LINK_MAX || /[\s\p{Cc}]/u.test(text)) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}

/** The part of a rendered node this file reads. Structurally a hast node. */
export interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** All text under a node, in order. */
export function textOf(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/** The language named on a fenced block, from its `language-*` class. */
export function langOf(node: HastNode | undefined): string | null {
  const classes = node?.properties?.className
  const list = Array.isArray(classes) ? classes : typeof classes === 'string' ? [classes] : []
  for (const entry of list) {
    const match = /^language-(.+)$/.exec(String(entry))
    if (match?.[1]) return match[1].toLowerCase().slice(0, 32)
  }
  return null
}

const components: Components = {
  // A fenced block is rebuilt from its node, so its text arrives whole and
  // the language, when named, is shown on the block.
  pre: ({ node }: { node?: HastNode }) => {
    const code = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code')
    const text = textOf(code ?? node).replace(/\n$/, '')
    const lang = langOf(code)
    return createElement(
      'pre',
      { className: 'code', 'data-lang': lang ?? undefined },
      createElement('code', null, text),
    )
  },
  // Only inline code reaches here: block code is handled by `pre` above.
  code: ({ children }: { children?: ReactNode }) =>
    createElement('code', { className: 'inline' }, children),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    const safe = safeHref(href)
    if (!safe) return createElement('span', { className: 'link dead' }, children)
    return createElement(
      'a',
      {
        href: safe,
        className: 'link',
        title: safe,
        onClick: (event: MouseEvent) => {
          event.preventDefault()
          openLink(safe)
        },
      },
      children,
    )
  },
  img: ({ src, alt }: { src?: unknown; alt?: string }) =>
    createElement(
      'span',
      { className: 'image' },
      alt ? `${alt} ` : 'image ',
      createElement('span', { className: 'mono' }, typeof src === 'string' ? src : ''),
    ),
  table: ({ children }: { children?: ReactNode }) =>
    createElement('div', { className: 'table-wrap' }, createElement('table', null, children)),
  // A task-list box is a fact about the list, not a control.
  input: ({ checked }: { checked?: boolean }) =>
    createElement('input', { type: 'checkbox', checked: !!checked, readOnly: true, className: 'task' }),
}

/** Render transcript Markdown to React elements. */
export function renderMarkdown(source: string): ReactNode {
  return createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components, children: source })
}
