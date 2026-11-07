/**
 * Screenshots and screen recordings the agent sends, as tiles (`.shot`) that
 * open full screen (their attached photos open in the same viewer). Bytes come from the API with the session token; in
 * fixtures mode they're bundled with the app.
 */
import type { MediaRef } from "@dream/domain"
import { useAtom, useAtomValue } from "@effect/atom-react"
import { Image } from "expo-image"
import { useVideoPlayer, VideoView } from "expo-video"
import { Option, Redacted } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect } from "react"
import { Modal, Pressable, ScrollView, type StyleProp, Text, View, type ViewStyle } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { sessionAtom } from "../state/atoms.ts"
import { appConfig } from "../state/runtime.ts"
import { viewerAtom } from "../state/ui.ts"
import { Icon, IconButton } from "./kit.tsx"
import { color, gutter } from "./theme.ts"

/** The fixtures' media, bundled. */
const bundled: Record<string, number> = {
  med_healthimport: require("../../assets/fixtures/health-import.mp4"),
  med_squatchart: require("../../assets/fixtures/squat-chart.png"),
  med_todayview: require("../../assets/fixtures/today-view.png"),
  med_cabincal: require("../../assets/fixtures/cabin-calendar.png"),
  med_cabinreq: require("../../assets/fixtures/cabin-requests.png"),
  med_cabinrot: require("../../assets/fixtures/cabin-rotation.png"),
  med_digest: require("../../assets/fixtures/digest.png"),
  med_attboard: require("../../assets/fixtures/attach-whiteboard.png"),
  med_attlist: require("../../assets/fixtures/attach-list.png")
}

type Source = number | { readonly uri: string; readonly headers: Record<string, string> }

/**
 * Photos they attached from this phone, by id: the picked file (or a fixture's bundled image), so their own photo
 * shows at once in Chat without loading it back.
 */
export const localMedia = new Map<string, number | string>()

export function useMediaSource(media: MediaRef): Source | undefined {
  const session = useAtomValue(sessionAtom)
  const fixture = bundled[media.id]
  if (fixture !== undefined) return fixture
  const local = localMedia.get(media.id)
  if (typeof local === "number") return local
  if (local !== undefined) return { uri: local, headers: {} }
  const signedIn = Option.flatten(AsyncResult.value(session))
  if (Option.isNone(signedIn)) return undefined
  return {
    uri: `${appConfig.apiUrl}/media/${encodeURIComponent(media.id)}`,
    headers: { authorization: `Bearer ${Redacted.value(signedIn.value.token)}` }
  }
}

const duration = (seconds: number) => {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** A still from the recording: its last moment, which usually shows what it proves. */
function VideoPoster(props: { readonly source: Source; readonly duration: number | undefined }) {
  const player = useVideoPlayer(props.source, (p) => {
    p.muted = true
    if (props.duration !== undefined) p.currentTime = Math.max(0, props.duration - 0.5)
  })
  return (
    <VideoView
      player={player}
      nativeControls={false}
      allowsVideoFrameAnalysis={false}
      contentFit="cover"
      style={{ width: "100%", height: "100%" }}
    />
  )
}

export function MediaTile(props: {
  readonly media: MediaRef
  readonly width: number
  readonly height: number
  readonly caption?: boolean
  readonly style?: StyleProp<ViewStyle>
}) {
  const { media, width, height } = props
  const source = useMediaSource(media)
  const [, open] = useAtom(viewerAtom)
  return (
    <View style={[{ width }, props.style]}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={media.caption ?? (media.kind === "video" ? "Recording" : "Screenshot")}
        onPress={() => open(Option.some(media))}
        style={({ pressed }) => ({
          width,
          height,
          borderRadius: width < 110 ? 14 : 18,
          overflow: "hidden",
          backgroundColor: color.s1,
          borderWidth: 1,
          borderColor: color.line,
          opacity: pressed ? 0.85 : 1
        })}
      >
        {source === undefined ? null : media.kind === "video" ? (
          <>
            <VideoPoster source={source} duration={media.durationSeconds} />
            <View
              style={{
                position: "absolute",
                inset: 0,
                experimental_backgroundImage: "linear-gradient(rgba(0,0,0,0.18), rgba(0,0,0,0.5))"
              }}
            />
            <View
              style={{
                position: "absolute",
                left: width / 2 - 17,
                top: height * 0.46 - 17,
                width: 34,
                height: 34,
                borderRadius: 17,
                backgroundColor: "rgba(255,255,255,0.22)",
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              <Icon name="play" size={14} color={color.white} />
            </View>
            {media.durationSeconds !== undefined ? (
              <Text
                style={{
                  position: "absolute",
                  left: 9,
                  bottom: 9,
                  fontSize: 10,
                  fontWeight: "600",
                  color: color.white,
                  backgroundColor: "rgba(0,0,0,0.55)",
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  borderRadius: 9,
                  overflow: "hidden",
                  fontVariant: ["tabular-nums"]
                }}
              >
                {duration(media.durationSeconds)}
              </Text>
            ) : null}
          </>
        ) : (
          <Image source={source} contentFit="cover" style={{ width: "100%", height: "100%" }} transition={150} />
        )}
      </Pressable>
      {props.caption !== false && media.caption ? (
        <Text style={{ fontSize: 12, color: color.t3, marginTop: 7 }} numberOfLines={1}>
          {media.caption}
        </Text>
      ) : null}
    </View>
  )
}

/** A horizontal strip of tiles (`.media`), bleeding to the screen edge. */
export function MediaStrip(props: {
  readonly media: ReadonlyArray<MediaRef>
  readonly inset: number
  readonly tile?: { readonly width: number; readonly height: number }
}) {
  const tile = props.tile ?? { width: 136, height: 240 }
  if (props.media.length === 0) return null
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginTop: 14, marginLeft: -props.inset, marginRight: -gutter }}
      contentContainerStyle={{ gap: 10, paddingLeft: props.inset, paddingRight: gutter }}
    >
      {props.media.map((media) => (
        <MediaTile
          key={media.id}
          media={media}
          width={tile.width}
          height={
            media.width && media.height
              ? Math.min(tile.height, Math.round((tile.width * media.height) / media.width))
              : tile.height
          }
        />
      ))}
    </ScrollView>
  )
}

function FullVideo(props: { readonly source: Source }) {
  const player = useVideoPlayer(props.source, (p) => {
    p.loop = false
    p.play()
  })
  useEffect(() => () => player.pause(), [player])
  return (
    <VideoView
      player={player}
      nativeControls
      allowsVideoFrameAnalysis={false}
      contentFit="contain"
      style={{ flex: 1 }}
    />
  )
}

/** Full-screen media, opened from any tile. */
export function MediaViewer() {
  const [viewing, setViewing] = useAtom(viewerAtom)
  const insets = useSafeAreaInsets()
  const media = Option.getOrUndefined(viewing)
  return (
    <Modal visible={media !== undefined} animationType="fade" onRequestClose={() => setViewing(Option.none())}>
      <View style={{ flex: 1, backgroundColor: color.black }}>
        {media ? <ViewerBody media={media} /> : null}
        <IconButton
          icon="close"
          label="Close"
          onPress={() => setViewing(Option.none())}
          style={{ position: "absolute", top: insets.top + 8, right: gutter }}
        />
        {media?.caption ? (
          <Text
            style={{
              position: "absolute",
              bottom: insets.bottom + 20,
              left: gutter,
              right: gutter,
              textAlign: "center",
              color: color.t2,
              fontSize: 14
            }}
          >
            {media.caption}
          </Text>
        ) : null}
      </View>
    </Modal>
  )
}

function ViewerBody(props: { readonly media: MediaRef }) {
  const source = useMediaSource(props.media)
  if (source === undefined) return null
  return props.media.kind === "video" ? (
    <FullVideo source={source} />
  ) : (
    <Image source={source} contentFit="contain" style={{ flex: 1 }} />
  )
}
