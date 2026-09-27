import { memo } from 'react'

import { renderMarkdown } from './markdown'

/**
 * Render transcript text. Memoised on the text, so while one reply streams
 * only that entry is parsed again; the rest of the transcript is untouched.
 */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  return <div className="md">{renderMarkdown(source)}</div>
})
