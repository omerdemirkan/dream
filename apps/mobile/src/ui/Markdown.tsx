/**
 * The markdown the agent writes in messages: paragraphs, lists, **bold**,
 * *italic*, `code` and links. Links open in Safari.
 */
import { Fragment, type ReactNode } from "react"
import { Linking, type StyleProp, Text, type TextStyle, View } from "react-native"
import { color } from "./theme.ts"

type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold" | "italic"; readonly children: ReadonlyArray<Inline> }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly url: string; readonly children: ReadonlyArray<Inline> }

const inlinePattern = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]))/

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

function renderInline(nodes: ReadonlyArray<Inline>, key = ""): ReactNode {
  return nodes.map((node, i) => {
    const k = `${key}${i}`
    switch (node.kind) {
      case "text":
        return <Fragment key={k}>{node.text}</Fragment>
      case "bold":
        return (
          <Text key={k} style={{ fontWeight: "600" }}>
            {renderInline(node.children, k)}
          </Text>
        )
      case "italic":
        return (
          <Text key={k} style={{ fontStyle: "italic" }}>
            {renderInline(node.children, k)}
          </Text>
        )
      case "code":
        return (
          <Text key={k} style={{ fontFamily: "Menlo", fontSize: 14, backgroundColor: color.s2 }}>
            {node.text}
          </Text>
        )
      case "link":
        return (
          <Text
            key={k}
            style={{ textDecorationLine: "underline" }}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(node.url)}
          >
            {renderInline(node.children, k)}
          </Text>
        )
    }
  })
}

export function Markdown(props: { readonly source: string; readonly style?: StyleProp<TextStyle> }) {
  const blocks = parseBlocks(props.source)
  const base: StyleProp<TextStyle> = [
    { fontSize: 16, lineHeight: 24, color: color.t1, letterSpacing: -0.16 },
    props.style
  ]
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((block, i) =>
        block.kind === "paragraph" ? (
          <Text key={i} style={base} selectable>
            {renderInline(parseInline(block.text))}
          </Text>
        ) : (
          <View key={i} style={{ gap: 4 }}>
            {block.items.map((item, j) => (
              <View key={j} style={{ flexDirection: "row", gap: 8 }}>
                <Text style={[base, { color: color.t2, minWidth: block.ordered ? 18 : 10 }]}>
                  {block.ordered ? `${j + 1}.` : "•"}
                </Text>
                <Text style={[base, { flex: 1 }]} selectable>
                  {renderInline(parseInline(item))}
                </Text>
              </View>
            ))}
          </View>
        )
      )}
    </View>
  )
}
