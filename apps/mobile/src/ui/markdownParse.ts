/**
 * A small markdown reader for agent messages: paragraphs, headings, bullet and
 * numbered lists, rules, fenced code, quotes, tables (too wide for a phone, so
 * read row by row), **bold**, *italic*, `code`, [links](https://…) and bare URLs.
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
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "table"; readonly rows: ReadonlyArray<ReadonlyArray<string>> }
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start: number; readonly items: ReadonlyArray<string> }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "rule" }

const fence = /^\s*(```|~~~)/
const heading = /^\s*#{1,6}\s+(.*)$/
const rule = /^\s*([-*_])(\s*\1){2,}\s*$/
const bullet = /^\s*[-*•+]\s+(.*)$/
const numbered = /^\s*(\d+)[.)]\s+(.*)$/
const quote = /^\s*>\s?(.*)$/
const tableRow = /^\s*\|.*\|\s*$/
const tableDivider = /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?$/

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())

/**
 * Line by line, the way agents write: a `**Label:**` line straight above its
 * bullets, `##` headings, `---` rules and fenced code. A list keeps its first
 * number, so items separated by blank lines still count 1, 2, 3.
 */
export const parseBlocks = (source: string): ReadonlyArray<Block> => {
  const blocks: Array<Block> = []
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  let paragraph: Array<string> = []
  let list: { ordered: boolean; start: number; items: Array<string> } | undefined
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") })
    if (list) blocks.push({ kind: "list", ...list })
    paragraph = []
    list = undefined
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (fence.test(line)) {
      flush()
      const code: Array<string> = []
      while (++i < lines.length && !fence.test(lines[i] ?? "")) code.push(lines[i] ?? "")
      blocks.push({ kind: "code", text: code.join("\n") })
      continue
    }
    if (line.trim().length === 0) {
      // A blank line ends a paragraph; a list continues if the next item follows.
      if (paragraph.length > 0) flush()
      continue
    }
    if (tableRow.test(line)) {
      flush()
      const rows: Array<ReadonlyArray<string>> = []
      for (; i < lines.length && tableRow.test(lines[i] ?? ""); i++) {
        if (!tableDivider.test(lines[i] ?? "")) rows.push(cells(lines[i] ?? ""))
      }
      i--
      blocks.push({ kind: "table", rows })
      continue
    }
    const q = quote.exec(line)
    if (q) {
      flush()
      const quoted = [q[1] ?? ""]
      while (i + 1 < lines.length && quote.test(lines[i + 1] ?? ""))
        quoted.push(quote.exec(lines[++i] ?? "")?.[1] ?? "")
      blocks.push({ kind: "quote", text: quoted.join("\n") })
      continue
    }
    const h = heading.exec(line)
    if (h) {
      flush()
      blocks.push({ kind: "heading", text: h[1] ?? "" })
      continue
    }
    if (rule.test(line)) {
      flush()
      blocks.push({ kind: "rule" })
      continue
    }
    const b = bullet.exec(line)
    const n = b ? undefined : numbered.exec(line)
    if ((b || n) && list && list.items.length > 0 && /^\s{2,}/.test(line)) {
      // An indented item nests under the item above it.
      list.items[list.items.length - 1] += `\n• ${(b ? b[1] : n?.[2]) ?? ""}`
      continue
    }
    if (b || n) {
      const ordered = n !== undefined && n !== null
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush()
      if (!list) {
        const start = n ? Number(n[1]) : 1
        list = { ordered, start, items: [] }
      }
      list.items.push((b ? b[1] : n?.[2]) ?? "")
      continue
    }
    if (list && /^\s+/.test(line) && list.items.length > 0) {
      // An indented line continues the item above it.
      list.items[list.items.length - 1] += `\n${line.trim()}`
      continue
    }
    if (list) flush()
    paragraph.push(line)
  }
  flush()
  return blocks
}

const inlineText = (nodes: ReadonlyArray<Inline>): string =>
  nodes.map((node) => (node.kind === "text" || node.kind === "code" ? node.text : inlineText(node.children))).join("")

/** A table row on one line: "Plan · Price · Limits". */
export const tableLine = (row: ReadonlyArray<string>) => row.filter((cell) => cell.length > 0).join(" · ")

/**
 * The markdown as lines of inline markdown, for text that sits in one run, like a heading or a clamped preview:
 * list items keep their bullet, a table reads row by row, code and rules drop out.
 */
export const inlineLines = (source: string): ReadonlyArray<string> =>
  parseBlocks(source).flatMap((block) => {
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "quote":
        return [block.text]
      case "list":
        return block.items.map((item, i) => `${block.ordered ? `${block.start + i}.` : "•"} ${item}`)
      case "table":
        return block.rows.map(tableLine)
      case "code":
      case "rule":
        return []
    }
  })

/** The message as plain text, one line per block, for a preview: no markers, no code. */
export const plainText = (source: string): string =>
  parseBlocks(source)
    .flatMap((block) =>
      block.kind === "paragraph" || block.kind === "heading" || block.kind === "quote"
        ? [inlineText(parseInline(block.text))]
        : block.kind === "list"
          ? block.items.map((item) => inlineText(parseInline(item)))
          : block.kind === "table"
            ? block.rows.map((row) => inlineText(parseInline(tableLine(row))))
            : []
    )
    .join("\n")
