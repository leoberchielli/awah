import type { ReactNode } from 'react'

const STRONG = /<strong>(.*?)<\/strong>/g

/**
 * Renders a translated string that carries `<strong>` emphasis.
 *
 * The obvious shortcut here is `dangerouslySetInnerHTML`, and it is the wrong
 * one: catalogs are meant to be edited by anyone who speaks the language, and
 * that route would turn every translation pull request into a script-injection
 * review. This splits on the one tag we allow and returns real elements, so
 * anything else a catalog contains is rendered as the literal text it is.
 */
export function Rich({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = []
  let cursor = 0

  for (const match of text.matchAll(STRONG)) {
    const at = match.index ?? 0
    if (at > cursor) parts.push(text.slice(cursor, at))
    parts.push(
      <strong key={`${at}-${match[1]}`} className="font-medium text-ink">
        {match[1]}
      </strong>,
    )
    cursor = at + match[0].length
  }

  if (cursor < text.length) parts.push(text.slice(cursor))

  return <>{parts}</>
}
