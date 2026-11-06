/**
 * An R2 bucket with what the Worker uses (put, get, head, with the content type kept): in memory, or in a
 * directory for scripts/updates-dev-server.ts.
 */
import type { R2Bucket } from "@cloudflare/workers-types"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

interface Stored {
  readonly bytes: Uint8Array
  readonly contentType: string | undefined
}

export const makeR2 = (dir?: string) => {
  const objects = new Map<string, Stored>()
  const file = (key: string) => `${dir}/${encodeURIComponent(key)}`
  if (dir !== undefined) mkdirSync(dir, { recursive: true })
  const load = (key: string): Stored | undefined => {
    const cached = objects.get(key)
    if (cached !== undefined || dir === undefined || !existsSync(file(key))) return cached
    const stored = {
      bytes: readFileSync(file(key)),
      contentType: readFileSync(`${file(key)}.type`, "utf8") || undefined
    }
    objects.set(key, stored)
    return stored
  }
  const meta = (key: string) => {
    const object = load(key)
    return object === undefined
      ? null
      : { key, size: object.bytes.length, httpMetadata: { contentType: object.contentType } }
  }
  const bucket = {
    head: async (key: string) => meta(key),
    get: async (key: string) => {
      const object = load(key)
      return object === undefined ? null : { ...meta(key), body: new Blob([object.bytes as any]).stream() }
    },
    put: async (
      key: string,
      value: ArrayBuffer | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } }
    ) => {
      const stored = { bytes: new Uint8Array(value as ArrayBuffer), contentType: options?.httpMetadata?.contentType }
      objects.set(key, stored)
      if (dir !== undefined) {
        writeFileSync(file(key), stored.bytes)
        writeFileSync(`${file(key)}.type`, stored.contentType ?? "")
      }
      return meta(key)
    },
    delete: async (keys: string | ReadonlyArray<string>) => {
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key)
    }
  }
  return { bucket: bucket as unknown as R2Bucket, objects }
}
