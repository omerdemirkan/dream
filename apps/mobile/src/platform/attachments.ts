/**
 * Picking photos and files on the phone, and uploading them.
 *
 * Photos come from the system photo picker (expo-image-picker) and are downscaled and saved as JPEG
 * (expo-image-manipulator) before they upload. Both are native modules that builds before attachments don't have,
 * so they're loaded only when present: on such a build `photosAvailable` is false and only files can be attached.
 * Files come from the Files picker (expo-document-picker), which every build has.
 */
import type { MediaUploadTarget } from "@dream/domain"
import { requireOptionalNativeModule } from "expo"
import * as DocumentPicker from "expo-document-picker"
import { File, Paths } from "expo-file-system"
import { Effect, Layer } from "effect"
import { AttachmentError, FileTransfer } from "../data/AttachmentUploads.ts"
import { contentTypeFor, type PickedFile, scaledTo } from "../data/attachments.ts"

type ImagePickerModule = typeof import("expo-image-picker")
type ImageManipulatorModule = typeof import("expo-image-manipulator")

const imagePicker: ImagePickerModule | undefined =
  requireOptionalNativeModule("ExponentImagePicker") === null ? undefined : require("expo-image-picker")
const imageManipulator: ImageManipulatorModule | undefined =
  requireOptionalNativeModule("ExpoImageManipulator") === null ? undefined : require("expo-image-manipulator")

/** Whether this build can open the photo library. */
export const photosAvailable = imagePicker !== undefined

const jpegName = (name: string) => `${name.replace(/\.[^.]+$/, "") || "Photo"}.jpg`

/** Large photos (and HEIC, which few tools read) become a JPEG no larger than the limit on its long edge. */
const downscaled = async (file: PickedFile): Promise<PickedFile> => {
  if (imageManipulator === undefined || file.width === undefined || file.height === undefined) return file
  const target = scaledTo(file.width, file.height)
  const fits = target.width === file.width && file.contentType !== "image/heic" && file.contentType !== "image/heif"
  if (fits) return file
  const rendered = await imageManipulator.ImageManipulator.manipulate(file.uri).resize(target).renderAsync()
  const saved = await rendered.saveAsync({ compress: 0.82, format: imageManipulator.SaveFormat.JPEG })
  return {
    ...file,
    uri: saved.uri,
    name: jpegName(file.name),
    contentType: "image/jpeg",
    sizeBytes: new File(saved.uri).size,
    width: saved.width,
    height: saved.height
  }
}

/** Photos from the library, up to `limit`; none if they cancelled. */
export const pickPhotos = async (limit: number): Promise<ReadonlyArray<PickedFile>> => {
  if (imagePicker === undefined || limit <= 0) return []
  const result = await imagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    orderedSelection: true,
    // HEIC photos arrive as JPEG, which the agent's tools can open.
    preferredAssetRepresentationMode: imagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    quality: 1
  })
  if (result.canceled) return []
  return Promise.all(
    result.assets.map((asset, index) =>
      downscaled({
        uri: asset.uri,
        name: asset.fileName ?? `Photo ${index + 1}.jpg`,
        contentType: contentTypeFor(asset.fileName ?? "photo.jpg", asset.mimeType),
        sizeBytes: asset.fileSize ?? new File(asset.uri).size,
        width: asset.width,
        height: asset.height,
        photo: true
      })
    )
  )
}

/** Files from the Files app, up to `limit`; none if they cancelled. Images among them are downscaled too. */
export const pickFiles = async (limit: number): Promise<ReadonlyArray<PickedFile>> => {
  if (limit <= 0) return []
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
  if (result.canceled) return []
  return Promise.all(
    result.assets.slice(0, limit).map((asset) => {
      const contentType = contentTypeFor(asset.name, asset.mimeType)
      const file: PickedFile = {
        uri: asset.uri,
        name: asset.name,
        contentType,
        sizeBytes: asset.size ?? new File(asset.uri).size,
        photo: false
      }
      return contentType.startsWith("image/") ? withPixels(file) : file
    })
  )
}

/** An image file's size in pixels, so it can be downscaled like a photo. */
const withPixels = async (file: PickedFile): Promise<PickedFile> => {
  if (imageManipulator === undefined) return file
  try {
    const image = await imageManipulator.ImageManipulator.manipulate(file.uri).renderAsync()
    return downscaled({ ...file, width: image.width, height: image.height })
  } catch {
    return file
  }
}

/** Uploads with expo-file-system, streaming from disk, as the target says. */
export const fileTransfer = Layer.succeed(
  FileTransfer,
  FileTransfer.of({
    put: (uri: string, target: MediaUploadTarget) =>
      Effect.tryPromise({
        try: () => new File(uri).upload(target.url, { httpMethod: target.method, headers: { ...target.headers } }),
        catch: () => new AttachmentError({ message: "The upload didn't go through. Check your connection." })
      }).pipe(
        Effect.flatMap((result) =>
          result.status >= 200 && result.status < 300
            ? Effect.void
            : Effect.fail(new AttachmentError({ message: result.body || "The upload didn't go through." }))
        )
      )
  })
)

/** Opens a sent file in Quick Look, downloading it first. */
export const previewFile = async (url: string, name: string, token: string): Promise<void> => {
  const destination = new File(Paths.cache, `attachment-${encodeURIComponent(url).slice(-24)}-${name}`)
  if (!destination.exists) {
    await File.downloadFileAsync(url, destination, { headers: { authorization: `Bearer ${token}` } })
  }
  await destination.preview()
}
