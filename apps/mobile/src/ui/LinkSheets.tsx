/**
 * The sheets over Home for app links: adding one (A3: putting back an app a project made that they took off Home),
 * changing one's icon, and putting one on the iPhone's Home Screen through Safari (H1).
 *
 * The phone has no photo picker in this build, so the person's icons are an SF Symbol or an emoji on a colour; an
 * agent's own image stays until they pick something else.
 */
import {
  type AppLink,
  isSingleEmoji,
  type LinkColor,
  type LinkIcon,
  linkHost,
  type Project,
  type ProjectSummary
} from "@dream/domain"
import { useAtom, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { KeyboardAvoidingView } from "react-native-keyboard-controller"
import Animated, { Easing, SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Svg, { Rect } from "react-native-svg"
import { linkChoices } from "../data/linkChoices.ts"
import { linksAtom, prepareHomeScreenFn, removedLinksAtom, restoreLinkFn, updateLinkFn } from "../state/atoms.ts"
import { linkSheetAtom } from "../state/ui.ts"
import { useAction, useToast } from "./actions.ts"
import { Button, Icon } from "./kit.tsx"
import { capture, LinkTile, LinkTileSvg, type TileLook } from "./LinkTile.tsx"
import { color, gutter, linkTile } from "./theme.ts"

const colors = Object.keys(linkTile) as ReadonlyArray<LinkColor>

/** Symbols to choose from; the link's own comes first when it isn't one of them. */
const symbols = [
  "house",
  "dumbbell",
  "sun.horizon",
  "calendar",
  "cart",
  "fork.knife",
  "book",
  "music.note",
  "chart.bar",
  "heart",
  "leaf",
  "tram",
  "airplane",
  "gamecontroller",
  "list.bullet"
] as const

const sameHost = (url: string, project: Project) => linkHost(url) === linkHost(project.publicUrl)

// ---------------------------------------------------------------------------
// The host and the sheet's chrome
// ---------------------------------------------------------------------------

export function LinkSheets(props: { readonly projects: ReadonlyArray<ProjectSummary> }) {
  const [sheet, setSheet] = useAtom(linkSheetAtom)
  const links = Option.getOrElse(AsyncResult.value(useAtomValue(linksAtom)), (): ReadonlyArray<AppLink> => [])
  const close = () => setSheet(Option.none())
  const current = Option.getOrUndefined(sheet)
  const link = current && current.kind !== "add" ? links.find((l) => l.id === current.linkId) : undefined
  const projects = props.projects.map((s) => s.project)
  return (
    <Sheet visible={current !== undefined && (current.kind === "add" || link !== undefined)} onClose={close}>
      {current?.kind === "add" ? (
        <AddLink links={links} projects={projects} onDone={close} />
      ) : current?.kind === "icon" && link ? (
        <ChangeIcon link={link} project={projects.find((p) => p.id === link.projectId)} onDone={close} />
      ) : current?.kind === "home-screen" && link ? (
        <HomeScreen link={link} projects={projects} onDone={close} />
      ) : null}
    </Sheet>
  )
}

function Sheet(props: { readonly visible: boolean; readonly onClose: () => void; readonly children: ReactNode }) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Pressable
          accessibilityLabel="Close"
          onPress={props.onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.58)" }]}
        />
        <KeyboardAvoidingView
          behavior="padding"
          style={{ flex: 1, justifyContent: "flex-end" }}
          pointerEvents="box-none"
        >
          <Animated.View
            entering={SlideInDown.duration(340).easing(Easing.bezier(0.2, 0.8, 0.2, 1))}
            style={{
              backgroundColor: color.sheet,
              borderTopLeftRadius: 34,
              borderTopRightRadius: 34,
              borderCurve: "continuous",
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: color.line,
              paddingHorizontal: gutter,
              paddingTop: 10,
              paddingBottom: Math.max(insets.bottom, 16) + 8,
              maxHeight: "90%"
            }}
          >
            <View
              style={{
                alignSelf: "center",
                width: 38,
                height: 5,
                borderRadius: 3,
                backgroundColor: "rgba(255,255,255,0.22)",
                marginBottom: 18
              }}
            />
            {props.children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

function Heading(props: { readonly title: string; readonly sub?: string | undefined }) {
  return (
    <View style={{ marginBottom: 18 }}>
      <Text style={{ fontSize: 24, fontWeight: "600", letterSpacing: -0.6, color: color.t1 }}>{props.title}</Text>
      {props.sub ? (
        <Text style={{ fontSize: 15, lineHeight: 21, color: color.t2, marginTop: 6 }}>{props.sub}</Text>
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Choosing a tile: a symbol, an emoji or the first letter, and a colour
// ---------------------------------------------------------------------------

/** A change from the picker: a new glyph (`icon: undefined` is the first letter), a new colour, or both. */
type TileChange = { readonly icon?: LinkIcon | undefined; readonly color?: LinkColor }

/** `look` with `change` applied. */
const applyTile = <A extends TileLook>(look: A, change: TileChange): A => {
  const { icon: _, ...rest } = look
  const icon = "icon" in change ? change.icon : look.icon
  return { ...rest, ...(change.color ? { color: change.color } : {}), ...(icon ? { icon } : {}) } as A
}

function TilePicker(props: { readonly look: TileLook; readonly onChange: (change: TileChange) => void }) {
  const { look } = props
  const [emoji, setEmoji] = useState(look.icon?._tag === "Emoji" ? look.icon.emoji : "")
  const current = look.icon
  const own = current?._tag === "Symbol" && !symbols.some((s) => s === current.name) ? [current.name] : []
  const choices: ReadonlyArray<LinkIcon | undefined> = [
    undefined,
    ...[...own, ...symbols].map((name): LinkIcon => ({ _tag: "Symbol", name }))
  ]
  const chosen = (icon: LinkIcon | undefined) =>
    icon === undefined
      ? look.icon === undefined
      : icon._tag === "Symbol" && look.icon?._tag === "Symbol" && look.icon.name === icon.name
  const pick = (icon: LinkIcon | undefined) => props.onChange({ icon })
  return (
    <View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
        {choices.map((icon, i) => (
          <Pressable
            key={icon?._tag === "Symbol" ? icon.name : `letter-${i}`}
            accessibilityRole="button"
            accessibilityLabel={icon?._tag === "Symbol" ? icon.name : "First letter"}
            accessibilityState={{ selected: chosen(icon) }}
            onPress={() => pick(icon)}
            style={{
              padding: 2,
              borderRadius: 14,
              borderWidth: 2,
              borderColor: chosen(icon) ? color.t1 : "transparent"
            }}
          >
            <LinkTile look={{ title: look.title, color: look.color, ...(icon ? { icon } : {}) }} size={42} />
          </Pressable>
        ))}
        <View
          style={{
            padding: 2,
            borderRadius: 14,
            borderWidth: 2,
            borderColor: look.icon?._tag === "Emoji" ? color.t1 : "transparent"
          }}
        >
          <TextInput
            value={emoji}
            onChangeText={(text) => {
              const value = [...text.trim()].slice(-8).join("")
              setEmoji(value)
              if (isSingleEmoji(value)) props.onChange({ icon: { _tag: "Emoji", emoji: value } })
            }}
            placeholder="☺︎"
            placeholderTextColor={color.t3}
            accessibilityLabel="An emoji"
            style={{
              width: 42,
              height: 42,
              borderRadius: 10,
              backgroundColor: color.s3,
              textAlign: "center",
              fontSize: 22,
              color: color.t1
            }}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 16 }}>
        {colors.map((name) => (
          <Pressable
            key={name}
            accessibilityRole="button"
            accessibilityLabel={name}
            accessibilityState={{ selected: look.color === name }}
            onPress={() => props.onChange({ color: name })}
            style={{
              padding: 1,
              borderRadius: 16,
              borderWidth: 2,
              borderColor: look.color === name ? color.t1 : "transparent"
            }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                experimental_backgroundImage: `linear-gradient(to bottom, ${linkTile[name].from}, ${linkTile[name].to})`
              }}
            />
          </Pressable>
        ))}
      </View>
    </View>
  )
}

/** The tile large, with its label as the row shows it. */
function Preview(props: { readonly look: TileLook }) {
  return (
    <View style={{ alignItems: "center", marginBottom: 6 }}>
      <LinkTile look={props.look} size={72} />
      <Text numberOfLines={1} style={{ maxWidth: 68, fontSize: 12, color: color.t1, marginTop: 8 }}>
        {props.look.title || " "}
      </Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Add an app (A3): only what agents made, so the apps they took off Home
// ---------------------------------------------------------------------------

function AddLink(props: {
  readonly links: ReadonlyArray<AppLink>
  readonly projects: ReadonlyArray<Project>
  readonly onDone: () => void
}) {
  const removed = useAtomValue(removedLinksAtom)
  if (!AsyncResult.isSuccess(removed)) return <View style={{ height: 220 }} />
  const choices = linkChoices(props.links, removed.value)
  if (choices._tag !== "Choices") return <NothingToAdd allOnHome={choices._tag === "AllOnHome"} onDone={props.onDone} />
  return (
    <ScrollView bounces={false}>
      <Heading title="Add an app" sub="Apps your projects made that you took off Home." />
      {choices.links.map((link, i) => (
        <RemovedLink
          key={link.id}
          link={link}
          project={props.projects.find((p) => p.id === link.projectId)}
          first={i === 0}
          onDone={props.onDone}
        />
      ))}
    </ScrollView>
  )
}

function RemovedLink(props: {
  readonly link: AppLink
  readonly project: Project | undefined
  readonly first: boolean
  readonly onDone: () => void
}) {
  const { link, project } = props
  const restore = useAction(restoreLinkFn)
  const toast = useToast()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 12,
        borderTopWidth: props.first ? 0 : 1,
        borderColor: color.line
      }}
    >
      <LinkTile look={link} size={48} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 17, color: color.t1 }}>
          {link.title}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 14, color: color.t3, marginTop: 2 }}>
          {project ? `Made by ${project.title}` : linkHost(link.url)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add ${link.title}`}
        disabled={restore.busy}
        onPress={() =>
          restore.run(link.id, {
            onSuccess: (back) => {
              props.onDone()
              toast(`Added ${back.title}`, { done: true })
            }
          })
        }
        style={({ pressed }) => ({
          paddingHorizontal: 18,
          height: 36,
          borderRadius: 18,
          backgroundColor: pressed ? "#3A3A40" : color.s3,
          justifyContent: "center",
          opacity: restore.busy ? 0.6 : 1
        })}
      >
        <Text style={{ fontSize: 15, fontWeight: "500", color: color.t1 }}>Add</Text>
      </Pressable>
    </View>
  )
}

/** Nothing to offer: why, and how apps get to Home. An empty slot of the row's shape stands for what's to come. */
function NothingToAdd(props: { readonly allOnHome: boolean; readonly onDone: () => void }) {
  return (
    <View>
      <View style={{ alignItems: "center", marginTop: 6, marginBottom: 22 }}>
        <Svg width={60} height={60}>
          <Rect
            x={0.75}
            y={0.75}
            width={58.5}
            height={58.5}
            rx={13.5}
            fill="none"
            stroke="rgba(255,255,255,0.22)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        </Svg>
      </View>
      <Text style={{ fontSize: 24, fontWeight: "600", letterSpacing: -0.6, color: color.t1, textAlign: "center" }}>
        {props.allOnHome ? "Everything’s on Home" : "Nothing to add yet"}
      </Text>
      <Text style={{ fontSize: 15, lineHeight: 21, color: color.t2, marginTop: 8, textAlign: "center" }}>
        {props.allOnHome
          ? "Every app your projects have made is in the row. If you take one off, it waits here until you want it back."
          : "When a project makes something you’ll open often, its agent puts it on Home. If you take one off, it waits here until you want it back."}
      </Text>
      <Button title="Done" variant="ghost" style={{ marginTop: 24 }} onPress={props.onDone} />
    </View>
  )
}

// ---------------------------------------------------------------------------
// Change icon
// ---------------------------------------------------------------------------

function ChangeIcon(props: {
  readonly link: AppLink
  readonly project: Project | undefined
  readonly onDone: () => void
}) {
  const { link, project } = props
  const [look, setLook] = useState<TileLook>({
    title: link.title,
    color: link.color,
    ...(link.icon ? { icon: link.icon } : {})
  })
  const update = useAction(updateLinkFn)
  const agents = link.addedBy === "agent" && project !== undefined
  return (
    <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
      <Heading
        title="Change icon"
        sub={agents ? `${project.title} keeps the icon you choose.` : "A symbol or an emoji, on a colour."}
      />
      <Preview look={look} />
      <TilePicker look={look} onChange={(change) => setLook((prev) => applyTile(prev, change))} />
      <Button
        title="Done"
        style={{ marginTop: 22 }}
        busy={update.busy}
        onPress={() => {
          const sameIcon = JSON.stringify(look.icon) === JSON.stringify(link.icon)
          if (sameIcon && look.color === link.color) return props.onDone()
          update.run(
            {
              linkId: link.id,
              ...(sameIcon ? {} : { icon: look.icon ?? null }),
              ...(look.color === link.color ? {} : { color: look.color })
            },
            { onSuccess: props.onDone }
          )
        }}
      />
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Put it on the Home Screen (H1)
// ---------------------------------------------------------------------------

function HomeScreen(props: {
  readonly link: AppLink
  readonly projects: ReadonlyArray<Project>
  readonly onDone: () => void
}) {
  const { link } = props
  const prepare = useAction(prepareHomeScreenFn)
  const tile = useRef<Svg>(null)
  const [busy, setBusy] = useState(false)
  const ours = props.projects.some((p) => sameHost(link.url, p))
  useEffect(() => () => setBusy(false), [])
  const open = async () => {
    setBusy(true)
    const iconPng = ours && link.icon?._tag !== "Image" ? await capture(tile.current) : undefined
    prepare.run(
      { linkId: link.id, iconPng },
      {
        onSuccess: ({ url }) => {
          setBusy(false)
          props.onDone()
          void Linking.openURL(url)
        },
        onFailure: () => {
          setBusy(false)
          props.onDone()
          void Linking.openURL(link.url)
        }
      }
    )
  }
  const steps: ReadonlyArray<{ readonly text: string; readonly glyph?: "dots" | "plusApp" }> = [
    { text: "Tap the three dots in Safari", glyph: "dots" },
    { text: "Share, then Add to Home Screen", glyph: "plusApp" },
    { text: "Tap Add" }
  ]
  return (
    <ScrollView bounces={false}>
      <Heading
        title={`Put ${link.title} on your Home Screen`}
        sub={
          ours
            ? "Safari adds it as an app: its own icon, full screen, no address bar."
            : `Safari adds it as an app that opens full screen, with the icon ${linkHost(link.url)} gives it.`
        }
      />
      <View
        style={{
          height: 150,
          borderRadius: 26,
          borderCurve: "continuous",
          overflow: "hidden",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 26,
          experimental_backgroundImage:
            "radial-gradient(120% 90% at 18% 10%, #3A4C86, transparent 60%), radial-gradient(90% 80% at 90% 100%, #6B4C95, transparent 60%), linear-gradient(to bottom, #1C2340, #121729)"
        }}
      >
        <View
          style={{
            width: 62,
            height: 62,
            borderRadius: 14,
            backgroundColor: "rgba(255,255,255,0.12)",
            marginBottom: 22
          }}
        />
        <View style={{ alignItems: "center", gap: 7 }}>
          {ours ? (
            link.icon?._tag === "Image" ? (
              <LinkTile look={link} size={62} />
            ) : (
              <View style={{ width: 62, height: 62, borderRadius: 14, borderCurve: "continuous", overflow: "hidden" }}>
                <LinkTileSvg ref={tile} look={link} size={62} />
              </View>
            )
          ) : (
            <View
              style={{
                width: 62,
                height: 62,
                borderRadius: 14,
                backgroundColor: "rgba(255,255,255,0.9)",
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              <Icon name="globe" size={28} color="#5A6170" />
            </View>
          )}
          <Text numberOfLines={1} style={{ maxWidth: 80, fontSize: 12, color: "#FFFFFF" }}>
            {link.title}
          </Text>
        </View>
        <View
          style={{
            width: 62,
            height: 62,
            borderRadius: 14,
            backgroundColor: "rgba(255,255,255,0.08)",
            marginBottom: 22
          }}
        />
      </View>
      <View
        style={{
          marginTop: 16,
          borderRadius: 22,
          borderWidth: 1,
          borderColor: color.line,
          backgroundColor: color.bg,
          paddingHorizontal: 16
        }}
      >
        {steps.map((step, i) => (
          <View
            key={step.text}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 14,
              paddingVertical: 14,
              borderTopWidth: i === 0 ? 0 : 1,
              borderColor: color.line
            }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: color.s3,
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              <Text style={{ fontSize: 13, color: color.t2 }}>{i + 1}</Text>
            </View>
            <Text style={{ flex: 1, fontSize: 16, color: color.t1 }}>{step.text}</Text>
            {step.glyph ? <Icon name={step.glyph} size={18} color={color.t2} /> : null}
          </View>
        ))}
      </View>
      <Button title="Open in Safari" style={{ marginTop: 20 }} busy={busy} onPress={() => void open()} />
    </ScrollView>
  )
}
