/**
 * A small markdown reader for agent messages: paragraphs, bullet and numbered
 * lists, **bold**, *italic*, `code`, [links](https://…) and bare URLs.
 */
export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold" | "italic"; readonly children: ReadonlyArray<Inline> }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly url: string; readonly children: ReadonlyArray<Inline> }

const inlinePattern =
  /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]))/

export const parseInline = (source: string): ReadonlyArray<Inline> => {
  const out: Array<Inline> = []
  let rest = source
  while (rest.length > 0) {
    const match = inlinePattern.exec(rest)
    if (!match) {
      out.push({ kind: "text", text: rest })
      break
    }
    if (match.index > 0) out.push({ kind: "text", text: rest.slice(0, match.index) })
    const [whole, , bold1, bold2, italic1, italic2, code, linkText, linkUrl, bare] = match
    if (bold1 ?? bold2) out.push({ kind: "bold", children: parseInline(bold1 ?? bold2 ?? "") })
    else if (italic1 ?? italic2) out.push({ kind: "italic", children: parseInline(italic1 ?? italic2 ?? "") })
    else if (code) out.push({ kind: "code", text: code })
    else if (linkText && linkUrl) out.push({ kind: "link", url: linkUrl, children: parseInline(linkText) })
    else if (bare) out.push({ kind: "link", url: bare, children: [{ kind: "text", text: bare }] })
    rest = rest.slice(match.index + whole.length)
  }
  return out
}

type Block =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: ReadonlyArray<string> }

export const parseBlocks = (source: string): ReadonlyArray<Block> => {
  const blocks: Array<Block> = []
  for (const chunk of source.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = chunk.split("\n").filter((line) => line.trim().length > 0)
    if (lines.length === 0) continue
    const bullet = /^\s*[-*•]\s+/
    const numbered = /^\s*\d+[.)]\s+/
    if (lines.every((line) => bullet.test(line))) {
      blocks.push({ kind: "list", ordered: false, items: lines.map((line) => line.replace(bullet, "")) })
    } else if (lines.every((line) => numbered.test(line))) {
      blocks.push({ kind: "list", ordered: true, items: lines.map((line) => line.replace(numbered, "")) })
    } else {
      blocks.push({ kind: "paragraph", text: lines.join("\n").replace(/^#+\s+/gm, "") })
    }
  }
  return blocks
}
