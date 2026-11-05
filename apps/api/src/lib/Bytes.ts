/**
 * Byte and text encodings for WebCrypto and JWTs. workerd has `btoa`/`atob`
 * but not `Uint8Array.prototype.toBase64`, so these go through binary strings.
 */

/** A WebCrypto key, named in a way both workerd's and Node's type definitions accept. */
export type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>

export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4))
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

export const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
  const clean = hex.trim()
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export const randomBytes = (length: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(length))

/** Compares two strings in time that depends only on their lengths. */
export const timingSafeEqual = (a: string, b: string): boolean => {
  const left = utf8(a)
  const right = utf8(b)
  let diff = left.length ^ right.length
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}
