/**
 * The markdown the agent writes in messages: paragraphs, headings, lists,
 * rules, code, quotes, tables, **bold**, *italic*, `code` and links. Links
 * open in Safari. `MarkdownText` is the same markdown in one run of text, for
 * headings and clamped previews.
 */
import { Fragment, type ReactNode, useState } from "react"
import { Linking, type StyleProp, Text, type TextStyle, View } from "react-native"
import { type Inline, inlineLines, parseBlocks, parseInline, tableLine } from "./markdownParse.ts"
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

export function Markdown(props: {
  readonly source: string
  readonly style?: StyleProp<TextStyle>
  /** Off in Chat and threads, where holding a message brings up its menu (with Copy) instead. */
  readonly selectable?: boolean
}) {
  const blocks = parseBlocks(props.source)
  const selectable = props.selectable ?? true
  const base: StyleProp<TextStyle> = [
    { fontSize: 16, lineHeight: 24, color: color.t1, letterSpacing: -0.16 },
    props.style
  ]
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "paragraph":
            return (
              <Text key={i} style={base} selectable={selectable}>
                {renderInline(parseInline(block.text))}
              </Text>
            )
          case "heading":
            return (
              <Text key={i} style={[base, { fontWeight: "600", marginTop: i === 0 ? 0 : 4 }]} selectable={selectable}>
                {renderInline(parseInline(block.text))}
              </Text>
            )
          case "rule":
            return <View key={i} style={{ height: 1, backgroundColor: color.line2, marginVertical: 4 }} />
          case "quote":
            return (
              <Text
                key={i}
                style={[base, { color: color.t2, borderLeftWidth: 2, borderColor: color.line2, paddingLeft: 12 }]}
                selectable={selectable}
              >
                {renderInline(parseInline(block.text))}
              </Text>
            )
          case "table":
            // Too wide for a phone: a row per line, the header row in bold.
            return (
              <View key={i} style={{ gap: 4 }}>
                {block.rows.map((row, j) => (
                  <Text
                    key={j}
                    style={[base, j === 0 && block.rows.length > 1 ? { fontWeight: "600" } : null]}
                    selectable={selectable}
                  >
                    {renderInline(parseInline(tableLine(row)))}
                  </Text>
                ))}
              </View>
            )
          case "code":
            return (
              <Text
                key={i}
                selectable={selectable}
                style={{
                  fontFamily: "Menlo",
                  fontSize: 13,
                  lineHeight: 19,
                  color: color.t1,
                  backgroundColor: color.s2,
                  borderRadius: 10,
                  overflow: "hidden",
                  padding: 10
                }}
              >
                {block.text}
              </Text>
            )
          case "list":
            return (
              <View key={i} style={{ gap: 4 }}>
                {block.items.map((item, j) => (
                  <View key={j} style={{ flexDirection: "row", gap: 8 }}>
                    <Text style={[base, { color: color.t2, minWidth: block.ordered ? 18 : 10 }]}>
                      {block.ordered ? `${block.start + j}.` : "•"}
                    </Text>
                    <Text style={[base, { flex: 1 }]} selectable={selectable}>
                      {renderInline(parseInline(item))}
                    </Text>
                  </View>
                ))}
              </View>
            )
        }
      })}
    </View>
  )
}

/**
 * Markdown in one run of text, at the size `style` sets: inline markdown renders, blocks become lines. With
 * `numberOfLines` it clamps, and `onClamp` hears whether anything was cut, measured against an unclamped copy.
 */
export function MarkdownText(props: {
  readonly source: string
  readonly style?: StyleProp<TextStyle>
  readonly numberOfLines?: number | undefined
  readonly onClamp?: ((clamped: boolean) => void) | undefined
}) {
  const [lines, setLines] = useState<number | undefined>(undefined)
  const content = inlineLines(props.source).map((line, i) => (
    <Fragment key={i}>
      {i > 0 ? "\n" : null}
      {renderInline(parseInline(line), `${i}-`)}
    </Fragment>
  ))
  const onClamp = props.onClamp
  const limit = props.numberOfLines
  return (
    <View>
      {limit !== undefined && onClamp ? (
        // Behind the visible text, so it never takes a tap.
        <Text
          accessibilityElementsHidden
          style={[props.style, { position: "absolute", left: 0, right: 0, top: 0, opacity: 0 }]}
          onTextLayout={(e) => {
            const count = e.nativeEvent.lines.length
            if (count === lines) return
            setLines(count)
            onClamp(count > limit)
          }}
        >
          {content}
        </Text>
      ) : null}
      <Text style={props.style} numberOfLines={limit}>
        {content}
      </Text>
    </View>
  )
}
