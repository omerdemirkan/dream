/**
 * Options to pick from (`QuestionMessage.previews`): when the agent built a few versions of something, the question
 * shows what each looks or sounds like. The card has a thumbnail per option, at the option's own shape; tapping one
 * opens them full screen, a page per option, to swipe between: screenshots (a desktop page turns sideways to fill
 * the screen), recordings with the system's controls, and sounds with a player. Picking asks for an optional note,
 * which is how they take parts of another option; "None of these" says what's missing.
 */
import type { MediaRef, QuestionAnswer, QuestionMessage } from "@dream/domain"
import { useAtom, useAtomSet } from "@effect/atom-react"
import { useEvent, useEventListener } from "expo"
import { Image } from "expo-image"
import { useVideoPlayer, VideoView } from "expo-video"
import { Option } from "effect"
import { useEffect, useRef, useState } from "react"
import {
  FlatList,
  type FlatListProps,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from "react-native"
import { KeyboardAvoidingView } from "react-native-keyboard-controller"
import Animated, { Easing, FadeIn, SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { answerNowFn } from "../state/atoms.ts"
import { optionsViewerAtom } from "../state/ui.ts"
import { useAction, useToast } from "./actions.ts"
import { ReasonField } from "./Composer.tsx"
import { useAskPush } from "./hooks.ts"
import { Button, Icon, IconButton, LinkButton } from "./kit.tsx"
import { type Source, useMediaSource, VideoPoster } from "./Media.tsx"
import {
  aspectOf,
  clock,
  contentsOf,
  fit,
  type OptionTile,
  optionTiles,
  type ThumbSize,
  thumbLayout
} from "./optionsLayout.ts"
import { color, gutter } from "./theme.ts"

/** Opens the viewer at an option. */
export function useOpenOptions() {
  const set = useAtomSet(optionsViewerAtom)
  return (message: QuestionMessage, index: number) => set(Option.some({ message, index }))
}

/** Sizes the phone measured for images that came without one, by media id. */
const measured = new Map<string, number>()

// ---------------------------------------------------------------------------
// Thumbnails, on the card and the expanded question
// ---------------------------------------------------------------------------

export function OptionThumbs(props: {
  readonly message: QuestionMessage
  /** The width they have: the card's inside. */
  readonly inner: number
  /** Where the strip may bleed to on the right (the card's padding plus the page's). */
  readonly bleed?: number
  readonly style?: object
}) {
  const open = useOpenOptions()
  const [, remeasured] = useState(0)
  const tiles = optionTiles(props.message)
  const answer = props.message.state._tag === "Answered" ? props.message.state.answer : undefined
  const picked = answer?._tag === "Choice" ? answer.option : undefined
  const aspects = tiles.map((tile) => {
    const first = tile.media[0]
    if (first === undefined) return "none" as const
    if (first.kind === "audio") return "audio" as const
    return aspectOf(first, measured.get(first.id))
  })
  const layout = thumbLayout(tiles, props.inner, aspects)
  const items = tiles.map((tile, i) => (
    <Thumb
      key={tile.option}
      tile={tile}
      size={layout.sizes[i]!}
      crop={layout.mode === "row"}
      dim={picked !== undefined && picked !== tile.option}
      picked={picked === tile.option}
      onMeasured={() => remeasured((n) => n + 1)}
      onPress={() => open(props.message, tile.index)}
    />
  ))
  return layout.mode === "row" ? (
    <View style={[{ flexDirection: "row", gap: 10 }, props.style]}>{items}</View>
  ) : (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[{ marginRight: -(props.bleed ?? 0) }, props.style]}
      contentContainerStyle={{ gap: 10, paddingRight: props.bleed ?? 0 }}
    >
      {items}
    </ScrollView>
  )
}

function Thumb(props: {
  readonly tile: OptionTile
  readonly size: ThumbSize
  readonly crop: boolean
  readonly dim: boolean
  readonly picked: boolean
  readonly onMeasured: () => void
  readonly onPress: () => void
}) {
  const { tile, size } = props
  const first = tile.media[0]
  const more = tile.media.length - 1
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Option ${tile.letter}, ${tile.option}${first ? `, ${contentsOf(tile.media)}` : ""}`}
      onPress={props.onPress}
      style={({ pressed }) => ({ width: size.width, opacity: props.dim ? 0.4 : pressed ? 0.85 : 1 })}
    >
      <View
        style={{
          width: size.width,
          height: size.height,
          borderRadius: 14,
          overflow: "hidden",
          backgroundColor: color.s2,
          borderWidth: props.picked ? 2 : 1,
          borderColor: props.picked ? color.t1 : color.line
        }}
      >
        {first === undefined ? (
          <WordsTile option={tile.option} />
        ) : (
          <ThumbMedia media={first} size={size} crop={props.crop} onMeasured={props.onMeasured} />
        )}
        {more > 0 ? <Text style={[badge, { position: "absolute", right: 7, top: 7 }]}>{`+${more}`}</Text> : null}
      </View>
      <Text
        numberOfLines={1}
        style={{ fontSize: 13, fontWeight: "600", color: color.t1, marginTop: 8, letterSpacing: -0.13 }}
      >
        {`${tile.letter} · ${tile.option}`}
      </Text>
    </Pressable>
  )
}

const badge = {
  fontSize: 10.5,
  fontWeight: "700" as const,
  color: color.white,
  backgroundColor: "rgba(10,10,12,0.78)",
  paddingHorizontal: 7,
  paddingVertical: 3,
  borderRadius: 9,
  overflow: "hidden" as const,
  fontVariant: ["tabular-nums" as const]
}

function WordsTile(props: { readonly option: string }) {
  return (
    <View style={{ flex: 1, padding: 12, justifyContent: "flex-end" }}>
      <Text numberOfLines={5} style={{ fontSize: 15, lineHeight: 19, fontWeight: "600", color: color.t2 }}>
        {props.option}
      </Text>
    </View>
  )
}

function ThumbMedia(props: {
  readonly media: MediaRef
  readonly size: ThumbSize
  readonly crop: boolean
  readonly onMeasured: () => void
}) {
  const { media } = props
  const source = useMediaSource(media)
  if (source === undefined) return null
  if (media.kind === "audio") {
    return (
      <View style={{ flex: 1, padding: 12, justifyContent: "space-between" }}>
        <Icon name="waveform" size={26} color={color.need} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={playDot}>
            <Icon name="play" size={12} color={color.black} />
          </View>
          {media.durationSeconds !== undefined ? (
            <Text style={{ fontSize: 12, color: color.t2, fontVariant: ["tabular-nums"] }}>
              {clock(media.durationSeconds)}
            </Text>
          ) : null}
        </View>
      </View>
    )
  }
  if (media.kind === "video") {
    return (
      <>
        <VideoPoster source={source} duration={media.durationSeconds} />
        <View
          style={[playDot, { position: "absolute", left: props.size.width / 2 - 15, top: props.size.height / 2 - 15 }]}
        >
          <Icon name="play" size={12} color={color.black} />
        </View>
        {media.durationSeconds !== undefined ? (
          <Text style={[badge, { position: "absolute", left: 7, bottom: 7 }]}>{clock(media.durationSeconds)}</Text>
        ) : null}
      </>
    )
  }
  return (
    <Image
      source={source}
      contentFit="cover"
      contentPosition="top"
      transition={150}
      style={{ width: "100%", height: "100%" }}
      onLoad={(event) => {
        if (media.width !== undefined || measured.has(media.id) || event.source.height === 0) return
        measured.set(media.id, event.source.width / event.source.height)
        props.onMeasured()
      }}
    />
  )
}

const playDot = {
  width: 30,
  height: 30,
  borderRadius: 15,
  backgroundColor: "rgba(255,255,255,0.9)",
  alignItems: "center" as const,
  justifyContent: "center" as const
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/** The viewer, above everything (the expanded question too); `_layout` puts it there. */
export function OptionsViewerHost() {
  const [viewing, setViewing] = useAtom(optionsViewerAtom)
  const view = Option.getOrUndefined(viewing)
  return (
    <Modal
      visible={view !== undefined}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={() => setViewing(Option.none())}
    >
      {view ? (
        <OptionsViewer
          key={view.message.id}
          message={view.message}
          start={view.index}
          onClose={() => setViewing(Option.none())}
        />
      ) : null}
    </Modal>
  )
}

type Sheet = { readonly kind: "pick"; readonly tile: OptionTile } | { readonly kind: "none" }

function OptionsViewer(props: {
  readonly message: QuestionMessage
  readonly start: number
  readonly onClose: () => void
}) {
  const m = props.message
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const tiles = optionTiles(m)
  const [current, setCurrent] = useState(Math.min(props.start, tiles.length - 1))
  const [area, setArea] = useState<number | undefined>(undefined)
  const [sheet, setSheet] = useState<Sheet | undefined>(undefined)
  const [zoomed, setZoomed] = useState<MediaRef | undefined>(undefined)
  // Once they've played a sound, swiping to the next option plays its sound too, so they can compare by ear.
  const [listening, setListening] = useState(false)
  const tile = tiles[current]!
  const answer = m.state._tag === "Answered" ? m.state.answer : undefined
  const picked = answer?._tag === "Choice" ? answer.option : undefined
  const onViewable = useRef(
    ({ viewableItems }: Parameters<NonNullable<FlatListProps<OptionTile>["onViewableItemsChanged"]>>[0]) => {
      const first = viewableItems[0]
      if (first?.index !== undefined && first.index !== null) setCurrent(first.index)
    }
  ).current
  const box: ThumbSize | undefined =
    area === undefined ? undefined : { width: window.width - 2 * gutter, height: area - 34 }
  const pickTitle =
    picked === tile.option
      ? "Your pick"
      : picked
        ? "Pick this instead"
        : `Pick ${tile.option.length <= 22 ? tile.option : tile.letter}`

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <View
        style={{
          paddingTop: insets.top + 4,
          paddingHorizontal: gutter,
          flexDirection: "row",
          alignItems: "center",
          gap: 12
        }}
      >
        <IconButton icon="close" label="Close" onPress={props.onClose} />
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>
            {m.question}
          </Text>
          <Text style={{ fontSize: 12.5, color: color.t3, marginTop: 2 }}>
            {tiles.length > 1 ? `${current + 1} of ${tiles.length} · swipe to compare` : "1 option"}
          </Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <View style={{ flex: 1, marginTop: 12 }} onLayout={(e) => setArea(e.nativeEvent.layout.height)}>
        {box ? (
          <FlatList
            data={tiles}
            keyExtractor={(t) => t.option}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={current}
            getItemLayout={(_, index) => ({ length: window.width, offset: window.width * index, index })}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
            windowSize={3}
            renderItem={({ item, index }) => (
              <OptionPage
                tile={item}
                box={box}
                width={window.width}
                active={index === current && sheet === undefined}
                listening={listening}
                onPlayed={() => setListening(true)}
                onZoom={setZoomed}
              />
            )}
          />
        ) : null}
      </View>

      <View style={{ paddingHorizontal: gutter, paddingBottom: Math.max(insets.bottom, 12) + 4, paddingTop: 12 }}>
        <Text
          numberOfLines={2}
          style={{ textAlign: "center", fontSize: 20, fontWeight: "600", letterSpacing: -0.6, color: color.t1 }}
        >
          {`${tile.letter} · ${tile.option}`}
        </Text>
        {tiles.length > 1 ? (
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, marginTop: 10 }}>
            {tiles.map((t) => (
              <View
                key={t.option}
                style={{
                  width: t.index === current ? 18 : 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: t.index === current ? color.t1 : "rgba(255,255,255,0.22)"
                }}
              />
            ))}
          </View>
        ) : null}
        {m.state._tag === "Withdrawn" ? (
          <Text style={{ textAlign: "center", color: color.t3, fontSize: 15, marginTop: 18, marginBottom: 8 }}>
            Dream doesn’t need an answer to this anymore.
          </Text>
        ) : (
          <>
            <Button
              title={pickTitle}
              variant="need"
              {...(picked === tile.option ? { trailing: "check" as const } : {})}
              disabled={picked === tile.option}
              onPress={() => setSheet({ kind: "pick", tile })}
              style={{ marginTop: 14 }}
            />
            <LinkButton title="None of these" onPress={() => setSheet({ kind: "none" })} />
          </>
        )}
      </View>

      {zoomed ? <Zoomed media={zoomed} onClose={() => setZoomed(undefined)} /> : null}
      {sheet ? (
        <AnswerSheet
          message={m}
          sheet={sheet}
          onCancel={() => setSheet(undefined)}
          onSent={() => {
            setSheet(undefined)
            props.onClose()
          }}
        />
      ) : null}
    </View>
  )
}

/** One option's page: each of its screens, recordings and sounds, fitted to the page, scrolling if there are several. */
function OptionPage(props: {
  readonly tile: OptionTile
  readonly box: ThumbSize
  readonly width: number
  readonly active: boolean
  readonly listening: boolean
  readonly onPlayed: () => void
  readonly onZoom: (media: MediaRef) => void
}) {
  const { tile, box } = props
  if (tile.media.length === 0) {
    return (
      <View style={{ width: props.width, paddingHorizontal: gutter }}>
        <View
          style={{
            height: box.height,
            borderRadius: 26,
            backgroundColor: color.s1,
            borderWidth: 1,
            borderColor: color.line,
            padding: 24,
            justifyContent: "flex-end"
          }}
        >
          <Text style={{ fontSize: 28, lineHeight: 33, fontWeight: "700", letterSpacing: -1, color: color.t1 }}>
            {tile.option}
          </Text>
          <Text style={{ fontSize: 15, color: color.t3, marginTop: 10 }}>
            No preview of this one; it’s in words only.
          </Text>
        </View>
      </View>
    )
  }
  const firstAudio = tile.media.findIndex((media) => media.kind === "audio")
  // With several, each is a little shorter than the page, so the next one shows below it and says there's more.
  const several = tile.media.length > 1
  const fitted = several ? { width: box.width, height: box.height - 64 } : box
  return (
    <ScrollView
      style={{ width: props.width }}
      contentContainerStyle={{ paddingHorizontal: gutter, gap: 22, paddingBottom: 8 }}
      showsVerticalScrollIndicator={false}
      // With one item that fits, it centers like a page; several scroll.
      centerContent
    >
      {tile.media.map((media, i) => (
        <View key={media.id} style={{ alignItems: "center" }}>
          <PageMedia
            media={media}
            box={fitted}
            active={props.active}
            autoplay={props.listening && i === firstAudio}
            onPlayed={props.onPlayed}
            onZoom={() => props.onZoom(media)}
          />
          {several || (media.caption && media.kind !== "audio") ? (
            <Text numberOfLines={1} style={{ fontSize: 13, color: color.t3, marginTop: 9 }}>
              {[media.caption, several ? `${i + 1} of ${tile.media.length}` : undefined].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
        </View>
      ))}
    </ScrollView>
  )
}

function PageMedia(props: {
  readonly media: MediaRef
  readonly box: ThumbSize
  readonly active: boolean
  readonly autoplay: boolean
  readonly onPlayed: () => void
  readonly onZoom: () => void
}) {
  const { media, box } = props
  const source = useMediaSource(media)
  const [aspect, setAspect] = useState(aspectOf(media, measured.get(media.id)))
  if (source === undefined) return null
  if (media.kind === "audio") {
    return (
      <AudioPlayer
        media={media}
        source={source}
        width={box.width}
        active={props.active}
        autoplay={props.autoplay}
        onPlayed={props.onPlayed}
      />
    )
  }
  const size = fit(aspect, box)
  if (media.kind === "video") return <PageVideo source={source} size={size} active={props.active} />
  const wide = aspect > 1.05
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`${media.caption ?? "Screen"}. ${wide ? "Turn it sideways to see it larger" : "Open it larger"}`}
      onPress={props.onZoom}
    >
      <Image
        source={source}
        contentFit="contain"
        transition={150}
        style={{ width: size.width, height: size.height, borderRadius: wide ? 12 : 22, backgroundColor: color.s1 }}
        onLoad={(event) => {
          if (media.width !== undefined || event.source.height === 0) return
          const loaded = event.source.width / event.source.height
          measured.set(media.id, loaded)
          setAspect(loaded)
        }}
      />
      {wide ? (
        <View
          style={{
            position: "absolute",
            right: 10,
            bottom: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            ...pill
          }}
        >
          <Icon name="rotate" size={13} color={color.white} />
          <Text style={{ fontSize: 12, fontWeight: "600", color: color.white }}>Larger</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const pill = {
  backgroundColor: "rgba(10,10,12,0.78)",
  paddingHorizontal: 10,
  paddingVertical: 6,
  borderRadius: 14
}

/** A recording, with the system's controls (scrubbing, full screen), paused when they swipe away. */
function PageVideo(props: { readonly source: Source; readonly size: ThumbSize; readonly active: boolean }) {
  // Until it's played, it rests on a frame a little way in: a recording's first frame is often a blank page.
  const player = useVideoPlayer(props.source, (p) => {
    p.loop = false
    p.currentTime = 1
  })
  const playing = useEvent(player, "playingChange", { isPlaying: false })?.isPlaying ?? false
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (!props.active) player.pause()
  }, [props.active, player])
  return (
    <View style={{ width: props.size.width, height: props.size.height, borderRadius: 18, overflow: "hidden" }}>
      <VideoView
        player={player}
        nativeControls={started}
        allowsVideoFrameAnalysis={false}
        contentFit="contain"
        style={{ width: "100%", height: "100%", backgroundColor: color.s1 }}
      />
      {started || playing ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Play the recording"
          onPress={() => {
            setStarted(true)
            player.currentTime = 0
            player.play()
          }}
          style={[
            StyleSheet.absoluteFill,
            { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.25)" }
          ]}
        >
          <View style={[playDot, { width: 64, height: 64, borderRadius: 32 }]}>
            <Icon name="play" size={24} color={color.black} />
          </View>
        </Pressable>
      )}
    </View>
  )
}

/** A sound: play and pause, how far it's got, and its length. */
function AudioPlayer(props: {
  readonly media: MediaRef
  readonly source: Source
  readonly width: number
  readonly active: boolean
  readonly autoplay: boolean
  readonly onPlayed: () => void
}) {
  const player = useVideoPlayer(props.source, (p) => {
    p.loop = false
    p.timeUpdateEventInterval = 0.1
  })
  const isPlaying = useEvent(player, "playingChange", { isPlaying: player.playing })?.isPlaying ?? false
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(props.media.durationSeconds ?? 0)
  useEventListener(player, "timeUpdate", ({ currentTime }) => setTime(currentTime))
  useEventListener(player, "sourceLoad", ({ duration }) => {
    if (duration > 0) setLength(duration)
  })
  useEventListener(player, "playToEnd", () => setTime(length))
  useEffect(() => {
    if (!props.active) {
      player.pause()
      return
    }
    if (props.autoplay) {
      player.currentTime = 0
      player.play()
    }
  }, [props.active, props.autoplay, player])
  const toggle = () => {
    if (isPlaying) return player.pause()
    if (length > 0 && time >= length - 0.15) player.currentTime = 0
    player.play()
    props.onPlayed()
  }
  const progress = length > 0 ? Math.min(1, time / length) : 0
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${isPlaying ? "Pause" : "Play"} ${props.media.caption ?? "sound"}`}
      onPress={toggle}
      style={({ pressed }) => ({
        width: props.width,
        borderRadius: 26,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: isPlaying ? color.needLine : color.line,
        padding: 22,
        opacity: pressed ? 0.9 : 1
      })}
    >
      <Bars playing={isPlaying} progress={progress} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 22 }}>
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: color.need,
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          <Icon name={isPlaying ? "pause" : "play"} size={22} color={color.needInk} />
        </View>
        <View style={{ flex: 1 }}>
          {props.media.caption ? (
            <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: "600", color: color.t1 }}>
              {props.media.caption}
            </Text>
          ) : null}
          <Text style={{ fontSize: 14, color: color.t3, marginTop: 3, fontVariant: ["tabular-nums"] }}>
            {length > 0 ? `${clock(time)} / ${clock(length)}` : clock(time)}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

/** A waveform drawn as bars, lit up to how far it has played. Not the sound's real shape: a picture of a sound. */
function Bars(props: { readonly playing: boolean; readonly progress: number }) {
  const heights = [10, 22, 34, 18, 42, 28, 50, 36, 24, 44, 30, 16, 38, 26, 46, 20, 32, 14, 40, 24, 12, 30, 18, 8]
  return (
    <View style={{ height: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      {heights.map((h, i) => (
        <View
          key={i}
          style={{
            width: 4,
            height: h,
            borderRadius: 2,
            backgroundColor:
              i / heights.length < props.progress ? color.need : props.playing ? "rgba(255,179,92,0.3)" : color.s3
          }}
        />
      ))}
    </View>
  )
}

/**
 * A screen larger, to pinch and pan. A page wider than tall turns sideways to use the phone's length, as if they'd
 * turned the phone; tapping anywhere closes it.
 */
function Zoomed(props: { readonly media: MediaRef; readonly onClose: () => void }) {
  const window = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const source = useMediaSource(props.media)
  const aspect = aspectOf(props.media, measured.get(props.media.id))
  const turned = aspect > 1.05
  // Turned, the image's width runs along the screen's height.
  const room = turned
    ? { width: window.height - 40, height: window.width - 24 }
    : { width: window.width, height: window.height }
  const size = fit(aspect, room)
  return (
    <Animated.View entering={FadeIn.duration(180)} style={[StyleSheet.absoluteFill, { backgroundColor: color.black }]}>
      <ScrollView
        maximumZoomScale={4}
        minimumZoomScale={1}
        centerContent
        bouncesZoom
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
      >
        <Pressable accessibilityLabel="Close" onPress={props.onClose}>
          <View
            style={
              turned ? { width: size.height, height: size.width, alignItems: "center", justifyContent: "center" } : null
            }
          >
            {source ? (
              <Image
                source={source}
                contentFit="contain"
                style={{ width: size.width, height: size.height, transform: turned ? [{ rotate: "90deg" }] : [] }}
              />
            ) : null}
          </View>
        </Pressable>
      </ScrollView>
      <IconButton
        icon="close"
        label="Close"
        onPress={props.onClose}
        style={{ position: "absolute", top: insets.top + 8, right: gutter }}
      />
    </Animated.View>
  )
}

/** Picking, with an optional note; or none of these, with what's missing. */
function AnswerSheet(props: {
  readonly message: QuestionMessage
  readonly sheet: Sheet
  readonly onCancel: () => void
  readonly onSent: () => void
}) {
  const m = props.message
  const insets = useSafeAreaInsets()
  const answer = useAction(answerNowFn)
  const askPush = useAskPush()
  const toast = useToast()
  const [note, setNote] = useState("")
  const pick = props.sheet.kind === "pick" ? props.sheet.tile : undefined
  const first = pick?.media[0]
  const send = () => {
    const text = note.trim()
    const reply: QuestionAnswer | undefined = pick
      ? { _tag: "Choice", option: pick.option, ...(text ? { note: text } : {}) }
      : text
        ? { _tag: "Freeform", text }
        : undefined
    if (!reply) return
    answer.run(
      { projectId: m.projectId, messageId: m.id, answer: reply },
      {
        onSuccess: () => {
          askPush()
          props.onSent()
        },
        onFailure: (message) => toast(message)
      }
    )
  }
  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={-(insets.bottom - 6)}
      style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}
    >
      <Pressable
        accessibilityLabel="Cancel"
        onPress={props.onCancel}
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.6)" }]}
      />
      <Animated.View
        entering={SlideInDown.duration(320).easing(Easing.bezier(0.22, 0.8, 0.2, 1).factory())}
        accessibilityViewIsModal
        style={{
          backgroundColor: color.sheet,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          borderTopWidth: 1,
          borderColor: color.line2,
          paddingTop: 10,
          paddingHorizontal: 20,
          paddingBottom: Math.max(insets.bottom, 12)
        }}
      >
        <View style={{ alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: color.line2 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 18 }}>
          {first && first.kind !== "audio" ? <SheetThumb media={first} /> : null}
          <View style={{ flex: 1 }}>
            <Text numberOfLines={2} style={{ fontSize: 24, fontWeight: "700", letterSpacing: -0.6, color: color.t1 }}>
              {pick ? pick.option : "None of these?"}
            </Text>
            <Text style={{ marginTop: 4, fontSize: 15, lineHeight: 21, color: color.t2 }}>
              {pick ? "Anything to add? Optional." : "Say what’s missing, and Dream tries again."}
            </Text>
          </View>
        </View>
        <View style={{ marginTop: 16 }}>
          <ReasonField
            value={note}
            onChange={setNote}
            multiline
            autoFocus={!pick}
            placeholder={pick ? "Add a note" : "What’s missing"}
            sample={
              pick ? "Yes, but open on A’s calendar so people see what’s free" : "Warmer colours, and fewer steps"
            }
          />
        </View>
        <Button
          title="Send"
          variant="need"
          busy={answer.busy}
          disabled={!pick && !note.trim()}
          onPress={send}
          style={{ marginTop: 16 }}
        />
        <LinkButton title="Cancel" onPress={props.onCancel} />
      </Animated.View>
    </KeyboardAvoidingView>
  )
}

function SheetThumb(props: { readonly media: MediaRef }) {
  const source = useMediaSource(props.media)
  const aspect = aspectOf(props.media, measured.get(props.media.id))
  const size = fit(aspect, { width: 72, height: 72 })
  if (source === undefined) return null
  return props.media.kind === "video" ? (
    <View style={{ ...size, borderRadius: 10, overflow: "hidden" }}>
      <VideoPoster source={source} duration={props.media.durationSeconds} />
    </View>
  ) : (
    <Image source={source} contentFit="cover" style={{ ...size, borderRadius: 10 }} />
  )
}
