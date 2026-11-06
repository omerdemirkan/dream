/**
 * Code signing for over-the-air updates, with WebCrypto only: an RSA key pair, the self-signed X.509 code signing
 * certificate expo-updates verifies against (the same shape `expo-updates codesigning:generate` makes: key usage
 * digitalSignature and extended key usage codeSigning, both critical), and RSASSA-PKCS1-v1_5 SHA-256 signatures
 * in the `expo-signature` header format.
 */
import { Effect } from "effect"
import { fromBase64, toBase64, utf8, type WebCryptoKey } from "./Bytes.ts"

const rsa = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }

// DER, just what a certificate needs.

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const tlv = (tag: number, ...content: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const body = concat(content)
  const n = body.length
  const length =
    n < 0x80
      ? [n]
      : n < 0x100
        ? [0x81, n]
        : n < 0x10000
          ? [0x82, n >> 8, n & 0xff]
          : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]
  return concat([new Uint8Array([tag, ...length]), body])
}

const sequence = (...items: ReadonlyArray<Uint8Array>) => tlv(0x30, ...items)
const set = (...items: ReadonlyArray<Uint8Array>) => tlv(0x31, ...items)
const explicit = (n: number, ...items: ReadonlyArray<Uint8Array>) => tlv(0xa0 + n, ...items)
const boolean = (value: boolean) => tlv(0x01, new Uint8Array([value ? 0xff : 0]))
const octetString = (bytes: Uint8Array) => tlv(0x04, bytes)
const bitString = (bytes: Uint8Array, unusedBits = 0) => tlv(0x03, new Uint8Array([unusedBits]), bytes)
const utf8String = (text: string) => tlv(0x0c, utf8(text))
const derNull = new Uint8Array([0x05, 0x00])

/** A non-negative INTEGER from big-endian bytes. */
const integer = (bytes: Uint8Array) => {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0 && bytes[start + 1]! < 0x80) start++
  const trimmed = bytes.subarray(start)
  return tlv(0x02, trimmed[0]! >= 0x80 ? concat([new Uint8Array([0]), trimmed]) : trimmed)
}

const oid = (dotted: string) => {
  const [first, second, ...rest] = dotted.split(".").map(Number)
  const bytes = [first! * 40 + second!]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128))
      chunk.unshift((value & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return tlv(0x06, new Uint8Array(bytes))
}

/** UTCTime until 2049, GeneralizedTime after (RFC 5280 4.1.2.5). */
const time = (at: Date) => {
  const iso = at.toISOString()
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  return at.getUTCFullYear() < 2050 ? tlv(0x17, utf8(digits.slice(2))) : tlv(0x18, utf8(digits))
}

const Oid = {
  sha256WithRsa: "1.2.840.113549.1.1.11",
  commonName: "2.5.4.3",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  codeSigning: "1.3.6.1.5.5.7.3.3"
}

const pem = (label: string, der: Uint8Array) => {
  const lines = toBase64(der).match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

const fromPem = (text: string) =>
  fromBase64(
    text
      .replace(/-----(BEGIN|END) [A-Z ]+-----/g, "")
      .replace(/\s+/g, "")
      .trim()
  )

export interface SigningKey {
  /** PKCS #8, base64 (sealed before it's stored). */
  readonly privateKeyPkcs8: string
  readonly certificatePem: string
}

/**
 * A new 2048-bit RSA key and its self-signed code signing certificate, valid from now until the end of 2049
 * (expo-updates checks the validity period on every update).
 */
export const generateSigningKey = (commonName: string): Effect.Effect<SigningKey> =>
  Effect.promise(async () => {
    const pair = (await crypto.subtle.generateKey(
      { ...rsa, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"]
    )) as { readonly publicKey: WebCryptoKey; readonly privateKey: WebCryptoKey }
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer)
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)
    const serial = crypto.getRandomValues(new Uint8Array(16))
    serial[0] = serial[0]! & 0x7f
    const name = sequence(set(sequence(oid(Oid.commonName), utf8String(commonName))))
    const algorithm = sequence(oid(Oid.sha256WithRsa), derNull)
    const now = new Date()
    const tbs = sequence(
      explicit(0, integer(new Uint8Array([2]))),
      integer(serial),
      algorithm,
      name,
      sequence(time(new Date(now.getTime() - 60_000)), time(new Date(Date.UTC(2049, 11, 31, 23, 59, 59)))),
      name,
      spki,
      explicit(
        3,
        sequence(
          // digitalSignature only (bit 0): 7 unused bits.
          sequence(oid(Oid.keyUsage), boolean(true), octetString(bitString(new Uint8Array([0x80]), 7))),
          sequence(oid(Oid.extKeyUsage), boolean(true), octetString(sequence(oid(Oid.codeSigning))))
        )
      )
    )
    const signature = new Uint8Array(await crypto.subtle.sign(rsa, pair.privateKey, tbs))
    return {
      privateKeyPkcs8: toBase64(pkcs8),
      certificatePem: pem("CERTIFICATE", sequence(tbs, algorithm, bitString(signature)))
    }
  })

/** Imports a stored private key for signing. */
export const importSigningKey = (privateKeyPkcs8: string): Effect.Effect<WebCryptoKey> =>
  Effect.promise(() => crypto.subtle.importKey("pkcs8", fromBase64(privateKeyPkcs8), rsa, false, ["sign"]))

/** The `expo-signature` value for `body`: an Expo SFV dictionary with the base64 signature, key id and algorithm. */
export const signatureHeader = (key: WebCryptoKey, body: string, keyId: string): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.sign(rsa, key, utf8(body))).pipe(
    Effect.map((signature) => `sig="${toBase64(new Uint8Array(signature))}", keyid="${keyId}", alg="rsa-v1_5-sha256"`)
  )

/** The DER bytes of a PEM certificate. */
export const certificateDer = fromPem
