/**
 * The markdown the agent writes in messages: paragraphs, lists, **bold**,
 * *italic*, `code` and links. Links open in Safari.
 */
import { Fragment, type ReactNode } from "react"
import { Linking, type StyleProp, Text, type TextStyle, View } from "react-native"
import { type Inline, parseBlocks, parseInline } from "./markdownParse.ts"
import { color } from "./theme.ts"

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
