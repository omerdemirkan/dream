/**
 * Who is signed in on this install, and the install's own id.
 *
 * The session token and the user record live in the keychain so the app opens
 * signed in. The device id is created once per install and survives sign-out,
 * so the API keeps one `Device` row per phone.
 */
import { DeviceId, User } from "@dream/domain"
import { Context, Effect, Layer, Option, Redacted, Schema, SubscriptionRef } from "effect"
import { SecureStorage } from "./SecureStorage.ts"

export interface SignedIn {
  readonly token: Redacted.Redacted<string>
  readonly user: User
}

const Keys = { token: "dream.session.token", user: "dream.session.user", deviceId: "dream.device.id" } as const

const UserJson = Schema.fromJsonString(Schema.toCodecJson(User))
const decodeUser = Schema.decodeUnknownOption(UserJson)
const encodeUser = Schema.encodeSync(UserJson)
const decodeDeviceId = Schema.decodeUnknownOption(DeviceId)

/** RFC 4122 v4. Uses the platform's generator when there is one. */
export const randomUuid = (): string => {
  const native = globalThis.crypto?.randomUUID
  if (native) return native.call(globalThis.crypto)
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16))
  hex[12] = "4"
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)
  const s = hex.join("")
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

export class Session extends Context.Service<
  Session,
  {
    readonly deviceId: DeviceId
    /** The signed-in person, or none. UI state subscribes to its changes. */
    readonly current: SubscriptionRef.SubscriptionRef<Option.Option<SignedIn>>
    readonly token: Effect.Effect<Option.Option<Redacted.Redacted<string>>>
    readonly signIn: (session: SignedIn) => Effect.Effect<void>
    readonly signOut: Effect.Effect<void>
  }
>()("@dream/mobile/Session") {
  static readonly layer = Layer.effect(
    Session,
    Effect.gen(function* () {
      const storage = yield* SecureStorage
      const read = (key: string) => storage.get(key).pipe(Effect.orElseSucceed(() => Option.none<string>()))

      const storedId = Option.flatMap(yield* read(Keys.deviceId), decodeDeviceId)
      const deviceId = Option.isSome(storedId) ? storedId.value : DeviceId.make(randomUuid())
      if (Option.isNone(storedId)) yield* storage.set(Keys.deviceId, deviceId).pipe(Effect.ignore)

      const token = yield* read(Keys.token)
      const user = Option.flatMap(yield* read(Keys.user), decodeUser)
      const initial: Option.Option<SignedIn> =
        Option.isSome(token) && Option.isSome(user)
          ? Option.some({ token: Redacted.make(token.value), user: user.value })
          : Option.none()
      const current = yield* SubscriptionRef.make(initial)

      return Session.of({
        deviceId,
        current,
        token: SubscriptionRef.get(current).pipe(Effect.map(Option.map((session) => session.token))),
        signIn: Effect.fn("Session.signIn")(function* (session: SignedIn) {
          yield* storage.set(Keys.token, Redacted.value(session.token)).pipe(Effect.ignore)
          yield* storage.set(Keys.user, encodeUser(session.user)).pipe(Effect.ignore)
          yield* SubscriptionRef.set(current, Option.some(session))
        }),
        signOut: Effect.gen(function* () {
          yield* storage.remove(Keys.token).pipe(Effect.ignore)
          yield* storage.remove(Keys.user).pipe(Effect.ignore)
          yield* SubscriptionRef.set(current, Option.none())
        }).pipe(Effect.withSpan("Session.signOut"))
      })
    })
  )
}
