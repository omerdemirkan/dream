/**
 * AES-GCM envelope encryption for user credentials. Each secret gets its own
 * random data key; the data key is wrapped with the master key (a Worker
 * secret that never leaves the Worker). The row's id, owner and kind are bound
 * in as additional data, so a ciphertext can't be moved to another row.
 */
import { Data, Effect } from "effect"
import { fromBase64, fromHex, fromUtf8, randomBytes, toBase64, utf8, type WebCryptoKey } from "./Bytes.ts"

export class SecretBoxError extends Data.TaggedError("SecretBoxError")<{ readonly reason: string }> {}

export interface Sealed {
  readonly keyVersion: number
  readonly wrappedKey: string
  readonly keyNonce: string
  readonly nonce: string
  readonly ciphertext: string
}

export interface SecretBox {
  readonly seal: (plaintext: string, additionalData: string) => Effect.Effect<Sealed>
  readonly open: (sealed: Sealed, additionalData: string) => Effect.Effect<string, SecretBoxError>
}

export const KeyVersion = 1

/** `masterKeyHex` is 32 random bytes, hex encoded (what `Alchemy.makeRandom` produces). */
export const makeSecretBox = (masterKeyHex: string): Effect.Effect<SecretBox, SecretBoxError> =>
  Effect.gen(function* () {
    const raw = fromHex(masterKeyHex)
    if (raw.length !== 32) return yield* new SecretBoxError({ reason: "the encryption key must be 32 bytes of hex" })
    const master = yield* Effect.promise(() =>
      crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["wrapKey", "unwrapKey"])
    )

    const seal = (plaintext: string, additionalData: string) =>
      Effect.promise(async (): Promise<Sealed> => {
        const dataKey = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
          "encrypt",
          "decrypt"
        ])) as WebCryptoKey
        const nonce = randomBytes(12)
        const keyNonce = randomBytes(12)
        const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: utf8(additionalData) },
          dataKey,
          utf8(plaintext)
        )
        const wrapped = await crypto.subtle.wrapKey("raw", dataKey, master, {
          name: "AES-GCM",
          iv: keyNonce,
          additionalData: utf8(additionalData)
        })
        return {
          keyVersion: KeyVersion,
          wrappedKey: toBase64(new Uint8Array(wrapped)),
          keyNonce: toBase64(keyNonce),
          nonce: toBase64(nonce),
          ciphertext: toBase64(new Uint8Array(ciphertext))
        }
      })

    const open = (sealed: Sealed, additionalData: string) =>
      Effect.tryPromise({
        try: async () => {
          const dataKey = await crypto.subtle.unwrapKey(
            "raw",
            fromBase64(sealed.wrappedKey),
            master,
            { name: "AES-GCM", iv: fromBase64(sealed.keyNonce), additionalData: utf8(additionalData) },
            { name: "AES-GCM" },
            false,
            ["decrypt"]
          )
          const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64(sealed.nonce), additionalData: utf8(additionalData) },
            dataKey,
            fromBase64(sealed.ciphertext)
          )
          return fromUtf8(new Uint8Array(plaintext))
        },
        catch: () => new SecretBoxError({ reason: "could not decrypt the secret" })
      })

    return { seal, open }
  })
