/**
 * Attaching photos and files (Deck v3 option A): a paperclip where the field starts opens the system's choice of
 * Photo Library or Choose File; what they pick waits in a tray in the composer, uploading, until they send; sent
 * ones sit above their bubble in Chat, photos as tiles and files as chips.
 *
 * Builds without the photo picker go straight to Files.
 */
import { type Attachment, AttachmentLimits, isImageAttachment, type MediaRef } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Cause, Exit, Option, Redacted } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Image } from "expo-image"
import { useCallback, useEffect, useRef, useState } from "react"
import { ActionSheetIOS, ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import {
  admit,
  fileDetail,
  isUploading,
  type PickedFile,
  readyIds,
  remove,
  type Staged,
  settle
} from "../data/attachments.ts"
import { describeError } from "../data/errors.ts"
import { photosAvailable, pickFiles, pickPhotos, previewFile } from "../platform/attachments.ts"
import { sessionAtom, uploadAttachmentFn } from "../state/atoms.ts"
import { appConfig } from "../state/runtime.ts"
import { viewerAtom } from "../state/ui.ts"
import { useToast } from "./actions.ts"
import { Icon } from "./kit.tsx"
import { localMedia, useMediaSource } from "./Media.tsx"
import { color } from "./theme.ts"

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StagedAttachments {
  readonly staged: ReadonlyArray<Staged>
  /** Opens the picker (the system's choice of photos or files first, where both are possible). */
  readonly attach: () => void
  readonly remove: (key: string) => void
  /** Uploaded ones, ready to send. */
  readonly ids: ReturnType<typeof readyIds>
  readonly uploading: boolean
  readonly clear: () => void
}

let keys = 0

/** What a composer has attached. `samples` (fixtures) are staged on arrival, as if just picked. */
export function useStagedAttachments(samples?: ReadonlyArray<PickedFile>): StagedAttachments {
  const [staged, setStaged] = useState<ReadonlyArray<Staged>>([])
  const current = useRef(staged)
  current.current = staged
  const upload = useAtomSet(uploadAttachmentFn, { mode: "promiseExit" })
  const toast = useToast()

  const add = useCallback(
    (picked: ReadonlyArray<PickedFile>) => {
      if (picked.length === 0) return
      const next = admit(current.current, picked, () => `att-${++keys}`)
      current.current = next.staged
      setStaged(next.staged)
      if (next.refused) toast(next.refused)
      for (const item of next.added) {
        void upload(item.file).then((exit) => {
          if (Exit.isSuccess(exit)) {
            localMedia.set(exit.value.id, item.file.preview ?? item.file.uri)
            setStaged((all) => settle(all, item.key, { _tag: "Ready", attachment: exit.value }))
            return
          }
          if (Cause.hasInterruptsOnly(exit.cause)) return
          // A failed one leaves the tray, and they hear why.
          setStaged((all) => remove(all, item.key))
          toast(describeError(Option.getOrUndefined(Cause.findErrorOption(exit.cause))))
        })
      }
    },
    [toast, upload]
  )

  useEffect(() => {
    if (samples && samples.length > 0) add(samples)
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = useCallback(
    (from: "photos" | "files") => {
      const room = AttachmentLimits.perMessage - current.current.length
      if (room <= 0) return toast(`A message can carry ${AttachmentLimits.perMessage} attachments.`)
      void (from === "photos" ? pickPhotos(room) : pickFiles(room)).then(add, () =>
        toast(from === "photos" ? "Couldn’t open that photo." : "Couldn’t open that file.")
      )
    },
    [add, toast]
  )

  const attach = useCallback(() => {
    if (!photosAvailable) return pick("files")
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Photo Library", "Choose File", "Cancel"], cancelButtonIndex: 2, userInterfaceStyle: "dark" },
      (index) => {
        if (index === 0) pick("photos")
        else if (index === 1) pick("files")
      }
    )
  }, [pick])

  return {
    staged,
    attach,
    remove: (key) => setStaged((all) => remove(all, key)),
    ids: readyIds(staged),
    uploading: isUploading(staged),
    clear: () => setStaged([])
  }
}

/** The paperclip: a quiet glyph inside the field, not a button beside it. */
export function AttachButton(props: { readonly onPress: () => void; readonly size?: number }) {
  const size = props.size ?? 40
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Attach a photo or file"
      onPress={props.onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? color.s3 : "transparent"
      })}
    >
      <Icon name="clip" size={Math.round(size * 0.5)} color={color.t2} />
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// The tray in a composer
// ---------------------------------------------------------------------------

const tile = 64

function RemoveBadge(props: { readonly name: string; readonly onPress: () => void; readonly ring: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove ${props.name}`}
      onPress={props.onPress}
      hitSlop={8}
      style={{
        position: "absolute",
        top: -6,
        right: -6,
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: "#3A3A40",
        borderWidth: 2,
        borderColor: props.ring,
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      <Icon name="close" size={9} color={color.t1} weight="bold" />
    </Pressable>
  )
}

function Uploading() {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 14,
        backgroundColor: "rgba(10,10,12,0.45)",
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      <ActivityIndicator size="small" color={color.t1} />
    </View>
  )
}

function FileChip(props: {
  readonly name: string
  readonly sizeBytes: number
  readonly height: number
  readonly onPress?: () => void
  readonly children?: React.ReactNode
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : undefined}
      accessibilityLabel={props.name}
      disabled={!props.onPress}
      onPress={props.onPress}
      style={({ pressed }) => ({
        height: props.height,
        maxWidth: 220,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingLeft: 11,
        paddingRight: 14,
        borderRadius: 14,
        backgroundColor: pressed ? color.s3 : color.s2,
        borderWidth: 1,
        borderColor: color.line
      })}
    >
      <View
        style={{
          width: 32,
          height: 38,
          borderRadius: 7,
          backgroundColor: color.s3,
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <Icon name="doc" size={17} color={color.t2} />
      </View>
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} ellipsizeMode="middle" style={{ fontSize: 14, fontWeight: "600", color: color.t1 }}>
          {props.name}
        </Text>
        <Text style={{ fontSize: 12.5, color: color.t3, marginTop: 2 }}>{fileDetail(props.name, props.sizeBytes)}</Text>
      </View>
      {props.children}
    </Pressable>
  )
}

/** What they've attached, above the field: photos as thumbnails, files as chips, each removable. */
export function AttachmentTray(props: {
  readonly staged: ReadonlyArray<Staged>
  readonly onRemove: (key: string) => void
  /** The colour behind the tray, for the ring around each remove badge. */
  readonly ring: string
  readonly inset?: number
}) {
  if (props.staged.length === 0) return null
  const inset = props.inset ?? 10
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 10, paddingHorizontal: inset, paddingTop: 10, paddingBottom: 2 }}
      style={{ flexGrow: 0 }}
    >
      {props.staged.map((item) => {
        const uploading = item.state._tag === "Uploading"
        const badge = <RemoveBadge name={item.file.name} onPress={() => props.onRemove(item.key)} ring={props.ring} />
        return item.file.photo || item.file.contentType.startsWith("image/") ? (
          <View key={item.key} style={{ width: tile, height: tile, marginTop: 4, marginRight: 4 }}>
            <Image
              source={item.file.preview ?? { uri: item.file.uri }}
              contentFit="cover"
              accessibilityLabel={item.file.name}
              style={{ width: tile, height: tile, borderRadius: 14, backgroundColor: color.s2 }}
            />
            {uploading ? <Uploading /> : null}
            {badge}
          </View>
        ) : (
          <View key={item.key} style={{ marginTop: 4, marginRight: 4 }}>
            <FileChip name={item.file.name} sizeBytes={item.file.sizeBytes} height={tile}>
              {uploading ? <ActivityIndicator size="small" color={color.t2} /> : null}
            </FileChip>
            {badge}
          </View>
        )
      })}
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Sent, in Chat
// ---------------------------------------------------------------------------

/** An attached photo, as the full-screen viewer takes it. */
export const attachmentAsMedia = (attachment: Attachment): MediaRef => ({
  id: attachment.id,
  kind: "image",
  contentType: attachment.contentType === "image/png" ? "image/png" : "image/jpeg",
  sizeBytes: attachment.sizeBytes,
  ...(attachment.width === undefined ? {} : { width: attachment.width }),
  ...(attachment.height === undefined ? {} : { height: attachment.height })
})

function SentPhoto(props: { readonly attachment: Attachment; readonly width: number; readonly height: number }) {
  const media = attachmentAsMedia(props.attachment)
  const source = useMediaSource(media)
  const open = useAtomSet(viewerAtom)
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={props.attachment.name}
      onPress={() => open(Option.some(media))}
      style={({ pressed }) => ({
        width: props.width,
        height: props.height,
        borderRadius: 16,
        overflow: "hidden",
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line,
        opacity: pressed ? 0.85 : 1
      })}
    >
      {source === undefined ? null : (
        <Image source={source} contentFit="cover" style={{ width: "100%", height: "100%" }} transition={150} />
      )}
    </Pressable>
  )
}

function SentFile(props: { readonly attachment: Attachment }) {
  const session = useAtomValue(sessionAtom)
  const toast = useToast()
  const signedIn = Option.flatten(AsyncResult.value(session))
  const { attachment } = props
  const open = Option.isNone(signedIn)
    ? undefined
    : () =>
        void previewFile(
          `${appConfig.apiUrl}/media/${encodeURIComponent(attachment.id)}`,
          attachment.name,
          Redacted.value(signedIn.value.token)
        ).catch(() => toast("Couldn’t open that file."))
  return (
    <FileChip
      name={attachment.name}
      sizeBytes={attachment.sizeBytes}
      height={56}
      {...(open === undefined ? {} : { onPress: open })}
    />
  )
}

/** Their attachments above their bubble, right-aligned: photos first as tiles, then files as chips. */
export function SentAttachments(props: { readonly attachments: ReadonlyArray<Attachment> }) {
  const photos = props.attachments.filter(isImageAttachment)
  const files = props.attachments.filter((a) => !isImageAttachment(a))
  const only = photos.length === 1 ? photos[0] : undefined
  const single =
    only === undefined
      ? undefined
      : (() => {
          const ratio = only.width && only.height ? only.height / only.width : 1.25
          const width = ratio >= 1 ? 168 : 232
          return { width, height: Math.round(Math.min(width * ratio, 260)) }
        })()
  return (
    <View style={{ alignItems: "flex-end", gap: 6, marginBottom: 6 }}>
      {photos.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, maxWidth: 296 }}>
          {photos.map((photo) =>
            single ? (
              <SentPhoto key={photo.id} attachment={photo} width={single.width} height={single.height} />
            ) : (
              <SentPhoto key={photo.id} attachment={photo} width={112} height={140} />
            )
          )}
        </View>
      ) : null}
      {files.map((file) => (
        <SentFile key={file.id} attachment={file} />
      ))}
    </View>
  )
}
