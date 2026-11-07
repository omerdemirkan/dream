/**
 * Fixtures: what `?attach=sample` stages in a composer, as if just picked, so the tray can be checked without the
 * photo library. Uploads go to the fake backend.
 */
import type { PickedFile } from "../data/attachments.ts"

export const sampleAttachments: ReadonlyArray<PickedFile> = [
  {
    uri: "fixtures://attach-whiteboard.png",
    name: "IMG_2041.png",
    contentType: "image/png",
    sizeBytes: 412_000,
    width: 480,
    height: 640,
    photo: true,
    preview: require("../../assets/fixtures/attach-whiteboard.png")
  },
  {
    uri: "fixtures://attach-list.png",
    name: "IMG_2042.png",
    contentType: "image/png",
    sizeBytes: 388_000,
    width: 480,
    height: 640,
    photo: true,
    preview: require("../../assets/fixtures/attach-list.png")
  },
  {
    uri: "fixtures://groceries.pdf",
    name: "groceries-october.pdf",
    contentType: "application/pdf",
    sizeBytes: 217_088,
    photo: false
  }
]

/** The samples for a route's `attach` parameter. */
export const samplesFor = (attach: string | undefined): ReadonlyArray<PickedFile> | undefined =>
  attach === "sample" ? sampleAttachments : undefined
