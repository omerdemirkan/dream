/**
 * An app link's tile: a rounded square in one of `linkTile`'s gradients with an SF Symbol, an emoji or the title's
 * first letter on it, or the agent's own image filling it. `LinkTileSvg` draws the same tile as an SVG, square and
 * full-bleed, so it can become a png for the Home Screen icon (iOS rounds it there).
 */
import type { AppLink, LinkColor, LinkIcon } from "@dream/domain"
import { Image } from "expo-image"
import { SymbolView, type SymbolViewProps } from "expo-symbols"
import { forwardRef } from "react"
import { Text, View } from "react-native"
import Svg, { Defs, ForeignObject, LinearGradient, Rect, Stop, Text as SvgText } from "react-native-svg"
import { useMediaSource } from "./Media.tsx"
import { linkTile } from "./theme.ts"

export type TileLook = Pick<AppLink, "title" | "icon" | "color">

/** iOS's icon corner, as a share of the side. */
const cornerRatio = 0.225

const monogram = (title: string) => ([...title.trim()][0] ?? "?").toUpperCase()

function ImageGlyph(props: { readonly icon: Extract<LinkIcon, { _tag: "Image" }>; readonly size: number }) {
  const source = useMediaSource(props.icon.media)
  return source === undefined ? null : (
    <Image source={source} contentFit="cover" style={{ width: props.size, height: props.size }} />
  )
}

/** The glyph in the middle of a tile `size` points wide. */
function Glyph(props: { readonly look: TileLook; readonly size: number }) {
  const { look, size } = props
  const ink = linkTile[look.color].ink
  const icon = look.icon
  if (icon?._tag === "Symbol") {
    const glyph = Math.round(size * 0.46)
    return (
      <SymbolView
        name={icon.name as SymbolViewProps["name"]}
        size={glyph}
        tintColor={ink}
        weight="semibold"
        resizeMode="scaleAspectFit"
        accessible={false}
        style={{ width: glyph, height: glyph }}
      />
    )
  }
  if (icon?._tag === "Emoji") {
    const glyph = Math.round(size * 0.52)
    return (
      <Text accessible={false} style={{ fontSize: glyph, lineHeight: glyph * 1.2 }}>
        {icon.emoji}
      </Text>
    )
  }
  const glyph = Math.round(size * 0.5)
  return (
    <Text
      accessible={false}
      style={{ fontSize: glyph, lineHeight: glyph * 1.15, fontWeight: "400", color: ink, letterSpacing: -0.5 }}
    >
      {monogram(look.title)}
    </Text>
  )
}

export function LinkTile(props: { readonly look: TileLook; readonly size?: number }) {
  const size = props.size ?? 60
  const { look } = props
  const tile = linkTile[look.color]
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * cornerRatio,
        borderCurve: "continuous",
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 0.5,
        borderColor: look.color === "light" ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.14)",
        experimental_backgroundImage:
          look.color === "purple"
            ? `linear-gradient(140deg, ${tile.from}, ${tile.to})`
            : `linear-gradient(to bottom, ${tile.from}, ${tile.to})`
      }}
    >
      {look.icon?._tag === "Image" ? <ImageGlyph icon={look.icon} size={size} /> : <Glyph look={look} size={size} />}
    </View>
  )
}

/** The tile as a square SVG `size` points wide, for capturing as the Home Screen icon. Not for image icons. */
export const LinkTileSvg = forwardRef<Svg, { readonly look: TileLook; readonly size: number }>(
  function LinkTileSvg(props, ref) {
    const { look, size } = props
    const tile = linkTile[look.color]
    const id = `tile-${look.color}`
    const diagonal = look.color === "purple"
    return (
      <Svg ref={ref} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2={diagonal ? "1" : "0"} y2="1">
            <Stop offset="0" stopColor={tile.from} />
            <Stop offset="1" stopColor={tile.to} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={size} height={size} fill={`url(#${id})`} />
        {look.icon?._tag === "Emoji" ? (
          <SvgText x={size / 2} y={size * 0.69} fontSize={size * 0.52} textAnchor="middle">
            {look.icon.emoji}
          </SvgText>
        ) : look.icon?._tag === "Symbol" ? (
          <ForeignObject x={0} y={0} width={size} height={size}>
            <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
              <Glyph look={look} size={size} />
            </View>
          </ForeignObject>
        ) : (
          <SvgText
            x={size / 2}
            y={size * 0.68}
            fontSize={size * 0.5}
            fontWeight="400"
            fill={tile.ink}
            textAnchor="middle"
          >
            {monogram(look.title)}
          </SvgText>
        )}
      </Svg>
    )
  }
)

export const tileInk = (color: LinkColor) => linkTile[color].ink
