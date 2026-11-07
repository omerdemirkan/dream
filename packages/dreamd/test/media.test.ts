/** What `dream` measures of a file before uploading it, and how `dream ask --show` reads its flag. */
import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { measure } from "../src/cli/MediaInfo.ts"
import { mediaType, parseShow } from "../src/cli/Parse.ts"

const bytes = (...parts: ReadonlyArray<ReadonlyArray<number> | string>) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : [...part])))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
const box = (type: string, ...content: ReadonlyArray<ReadonlyArray<number>>) => {
  const body = content.flat()
  return [...be32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body]
}
const zeros = (n: number) => Array.from({ length: n }, () => 0)

/** An mp4's moov: a 9.5 s movie with one track, optionally turned a quarter. */
const mp4 = (width: number, height: number, turned = false) => {
  const mvhd = box("mvhd", [0, 0, 0, 0], zeros(8), be32(1000), be32(9500), zeros(80))
  const matrix = turned
    ? [...be32(0), ...be32(0x10000), ...be32(0), ...be32(-0x10000 >>> 0), ...be32(0), ...zeros(16)]
    : [...be32(0x10000), ...zeros(12), ...be32(0x10000), ...zeros(16)]
  const tkhd = box("tkhd", [0, 0, 0, 7], zeros(36), matrix, be32(width * 65536), be32(height * 65536))
  return new Uint8Array([...box("ftyp", [...bytes("isom")], zeros(4)), ...box("moov", mvhd, box("trak", tkhd))])
}

describe("measuring media", () => {
  it("reads a png's and a jpg's size", () => {
    const png = bytes([0x89], "PNG", [13, 10, 26, 10], be32(13), "IHDR", be32(2880), be32(1800), zeros(5))
    assert.deepStrictEqual(measure("image/png", png), { width: 2880, height: 1800 })
    const jpg = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8], [0x0a, 0x8c], [0x04, 0x92], zeros(6))
    assert.deepStrictEqual(measure("image/jpeg", jpg), { width: 1170, height: 2700 })
  })

  it("reads an mp4's size and length, turned or not, and an m4a's length", () => {
    assert.deepStrictEqual(measure("video/mp4", mp4(1920, 1080)), { width: 1920, height: 1080, durationSeconds: 9.5 })
    assert.deepStrictEqual(measure("video/mp4", mp4(1920, 1080, true)), { width: 1080, height: 1920, durationSeconds: 9.5 })
    assert.deepStrictEqual(measure("audio/mp4", mp4(0, 0)), { durationSeconds: 9.5 })
  })

  it("reads a wav's length", () => {
    const rate = 44100 * 2
    const wav = bytes("RIFF", le32(0), "WAVE", "fmt ", le32(16), [1, 0, 1, 0], le32(44100), le32(rate), [2, 0, 16, 0], "data", le32(rate * 2))
    assert.deepStrictEqual(measure("audio/wav", wav), { durationSeconds: 2 })
  })

  it("leaves out what it can't read", () => {
    assert.deepStrictEqual(measure("image/png", bytes("not a png")), {})
    assert.deepStrictEqual(measure("video/mp4", bytes("nonsense!")), {})
    assert.deepStrictEqual(measure("audio/mpeg", bytes("ID3")), {})
  })
})

describe("dream ask --show", () => {
  it("names an option and its files", () => {
    assert.deepStrictEqual(parseShow("Calendar first=shots/a-*.png"), Result.succeed({ option: "Calendar first", files: ["shots/a-*.png"] }))
    assert.deepStrictEqual(parseShow("x = y=a.png, b.mp4"), Result.succeed({ option: "x = y", files: ["a.png", "b.mp4"] }))
    assert.isTrue(Result.isFailure(parseShow("Calendar first")))
    assert.isTrue(Result.isFailure(parseShow("=a.png")))
  })

  it("takes audio only for previews", () => {
    assert.deepStrictEqual(mediaType("chime.m4a", true), Result.succeed("audio/mp4"))
    assert.deepStrictEqual(mediaType("voice.MP3", true), Result.succeed("audio/mpeg"))
    const inMessage = mediaType("chime.m4a")
    assert.isTrue(Result.isFailure(inMessage) && inMessage.failure.includes("only as an option's preview"))
  })
})
