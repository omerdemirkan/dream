/**
 * What `dream` measures of a file before uploading it, so the phone can lay a preview out at its own shape before
 * the bytes arrive: pixel size for png, jpg and mp4, and length for mp4, m4a and wav. Anything it can't read is left
 * out, and the phone measures it when it loads.
 */
import type { MediaContentType } from "@dream/domain"

export interface MediaInfo {
  readonly width?: number
  readonly height?: number
  readonly durationSeconds?: number
}

const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!
const u32 = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!)
const le32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!)
const s32 = (b: Uint8Array, at: number) => u32(b, at) | 0

const size = (width: number, height: number): MediaInfo => (width > 0 && height > 0 ? { width, height } : {})

const png = (b: Uint8Array): MediaInfo =>
  b.length >= 24 && tag(b, 12) === "IHDR" ? size(u32(b, 16), u32(b, 20)) : {}

const jpeg = (b: Uint8Array): MediaInfo => {
  let at = 2
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return {}
    const marker = b[at + 1]!
    if (marker === 0xff) {
      at += 1
      continue
    }
    const length = u16(b, at + 2)
    // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return size(u16(b, at + 7), u16(b, at + 5))
    }
    at += 2 + length
  }
  return {}
}

/** The boxes directly inside `[start, end)`. */
const boxes = function* (b: Uint8Array, start: number, end: number) {
  let at = start
  while (at + 8 <= end) {
    let length = u32(b, at)
    let header = 8
    if (length === 1 && at + 16 <= end) {
      length = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12)
      header = 16
    } else if (length === 0) length = end - at
    if (length < header || at + length > end) return
    yield { type: tag(b, at + 4), body: at + header, end: at + length }
    at += length
  }
}

const mp4 = (b: Uint8Array): MediaInfo => {
  const moov = [...boxes(b, 0, b.length)].find((box) => box.type === "moov")
  if (moov === undefined) return {}
  let info: { width?: number; height?: number; durationSeconds?: number } = {}
  for (const box of boxes(b, moov.body, moov.end)) {
    if (box.type === "mvhd") {
      const v1 = b[box.body] === 1
      const timescale = u32(b, box.body + (v1 ? 20 : 12))
      const duration = v1 ? u32(b, box.body + 24) * 2 ** 32 + u32(b, box.body + 28) : u32(b, box.body + 16)
      if (timescale > 0) info = { ...info, durationSeconds: Math.round((duration / timescale) * 10) / 10 }
    }
    if (box.type === "trak" && info.width === undefined) {
      const tkhd = [...boxes(b, box.body, box.end)].find((inner) => inner.type === "tkhd")
      if (tkhd === undefined) continue
      const v1 = b[tkhd.body] === 1
      const matrix = tkhd.body + (v1 ? 52 : 40)
      const width = u32(b, matrix + 36) / 65536
      const height = u32(b, matrix + 40) / 65536
      // A track turned a quarter (b ≠ 0 in its matrix) shows with width and height swapped.
      const turned = s32(b, matrix + 4) !== 0
      if (width > 0 && height > 0) info = { ...info, ...(turned ? size(height, width) : size(width, height)) }
    }
  }
  return info
}

const wav = (b: Uint8Array): MediaInfo => {
  if (b.length < 12 || tag(b, 0) !== "RIFF" || tag(b, 8) !== "WAVE") return {}
  let byteRate = 0
  let at = 12
  while (at + 8 <= b.length) {
    const id = tag(b, at)
    const length = le32(b, at + 4)
    if (id === "fmt " && at + 20 <= b.length) byteRate = le32(b, at + 16)
    if (id === "data") return byteRate > 0 ? { durationSeconds: Math.round((length / byteRate) * 10) / 10 } : {}
    at += 8 + length + (length % 2)
  }
  return {}
}

export const measure = (contentType: MediaContentType, bytes: Uint8Array): MediaInfo => {
  switch (contentType) {
    case "image/png":
      return png(bytes)
    case "image/jpeg":
      return jpeg(bytes)
    case "video/mp4":
      return mp4(bytes)
    case "audio/mp4": {
      const { durationSeconds } = mp4(bytes)
      return durationSeconds === undefined ? {} : { durationSeconds }
    }
    case "audio/wav":
      return wav(bytes)
    case "audio/mpeg":
      return {}
  }
}
