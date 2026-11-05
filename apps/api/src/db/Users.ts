/**
 * People, the invite list, and their devices (D1).
 */
import { Device, DeviceId, TimeZone, User, UserId } from "@dream/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { newUserId } from "../lib/Ids.ts"
import { decodeFirst, decodeRows, exec, IsoDate, nowIso, orNull } from "./Sql.ts"

const UserRow = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  google_sub: Schema.NullOr(Schema.String),
  time_zone: Schema.NullOr(TimeZone),
  created_at: IsoDate
})
type UserRow = typeof UserRow.Type

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  ...(row.name === null ? {} : { name: row.name }),
  ...(row.time_zone === null ? {} : { timeZone: row.time_zone }),
  createdAt: row.created_at
})

const DeviceRow = Schema.Struct({
  id: DeviceId,
  user_id: UserId,
  platform: Schema.Literal("ios"),
  apns_token: Schema.NullOr(Schema.String),
  push_to_start_token: Schema.NullOr(Schema.String),
  time_zone: TimeZone,
  app_version: Schema.NullOr(Schema.String),
  updated_at: IsoDate
})
type DeviceRow = typeof DeviceRow.Type

const toDevice = (row: DeviceRow): Device => ({
  id: row.id,
  userId: row.user_id,
  platform: row.platform,
  ...(row.apns_token === null ? {} : { apnsToken: row.apns_token }),
  ...(row.push_to_start_token === null ? {} : { pushToStartToken: row.push_to_start_token }),
  timeZone: row.time_zone,
  ...(row.app_version === null ? {} : { appVersion: row.app_version }),
  updatedAt: row.updated_at
})

export interface RegisterDevice {
  readonly deviceId: DeviceId
  readonly apnsToken?: string | undefined
  readonly pushToStartToken?: string | undefined
  readonly timeZone: TimeZone
  readonly appVersion?: string | undefined
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export class Users extends Context.Service<
  Users,
  {
    readonly find: (id: UserId) => Effect.Effect<Option.Option<User>>
    readonly findByEmail: (email: string) => Effect.Effect<Option.Option<User>>
    readonly isInvited: (email: string) => Effect.Effect<boolean>
    readonly invite: (email: string, note?: string) => Effect.Effect<void>
    /** Find or create the person behind a verified Google identity. */
    readonly upsertGoogle: (identity: {
      readonly sub: string
      readonly email: string
      readonly name?: string | undefined
    }) => Effect.Effect<User>
    /** Find or create a person by email (dev sign-in). */
    readonly upsertByEmail: (email: string, name?: string) => Effect.Effect<User>
    readonly registerDevice: (userId: UserId, device: RegisterDevice) => Effect.Effect<Device>
    readonly unregisterDevice: (userId: UserId, deviceId: DeviceId) => Effect.Effect<void>
    readonly devices: (userId: UserId) => Effect.Effect<ReadonlyArray<Device>>
    /** APNs said this token is no longer valid. */
    readonly forgetApnsToken: (token: string) => Effect.Effect<void>
    readonly forgetPushToStartToken: (token: string) => Effect.Effect<void>
  }
>()("@dream/api/Users") {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const find = (id: UserId) =>
        sql`SELECT * FROM users WHERE id = ${id}`.pipe(
          decodeFirst(UserRow),
          Effect.map(Option.fromUndefinedOr),
          Effect.map(Option.map(toUser))
        )

      const findByEmail = (email: string) =>
        sql`SELECT * FROM users WHERE email = ${normalizeEmail(email)}`.pipe(
          decodeFirst(UserRow),
          Effect.map((row) => Option.map(Option.fromUndefinedOr(row), toUser))
        )

      const isInvited = (email: string) =>
        sql`SELECT email FROM invites WHERE email = ${normalizeEmail(email)}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        )

      const invite = (email: string, note?: string) =>
        Effect.gen(function* () {
          const now = yield* nowIso
          yield* exec(
            sql`INSERT INTO invites (email, note, created_at) VALUES (${normalizeEmail(email)}, ${orNull(note)}, ${now})
                ON CONFLICT (email) DO NOTHING`
          )
        })

      const upsertByEmail = Effect.fn("Users.upsertByEmail")(function* (rawEmail: string, name?: string) {
        const email = normalizeEmail(rawEmail)
        const existing = yield* findByEmail(email)
        if (Option.isSome(existing)) {
          if (name !== undefined && existing.value.name !== name) {
            yield* exec(sql`UPDATE users SET name = ${name} WHERE id = ${existing.value.id}`)
            return { ...existing.value, name }
          }
          return existing.value
        }
        const id = yield* newUserId()
        const now = yield* nowIso
        yield* exec(
          sql`INSERT INTO users (id, email, name, created_at) VALUES (${id}, ${email}, ${orNull(name)}, ${now})`
        )
        return (yield* find(id)).pipe(Option.getOrThrow)
      })

      const upsertGoogle = Effect.fn("Users.upsertGoogle")(function* (identity: {
        readonly sub: string
        readonly email: string
        readonly name?: string | undefined
      }) {
        const bySub = yield* sql`SELECT * FROM users WHERE google_sub = ${identity.sub}`.pipe(decodeFirst(UserRow))
        if (bySub !== undefined) {
          const email = normalizeEmail(identity.email)
          if (bySub.email !== email || (identity.name !== undefined && bySub.name !== identity.name)) {
            yield* exec(
              sql`UPDATE users SET email = ${email}, name = ${orNull(identity.name ?? bySub.name ?? undefined)} WHERE id = ${bySub.id}`
            )
          }
          return (yield* find(bySub.id)).pipe(Option.getOrThrow)
        }
        const user = yield* upsertByEmail(identity.email, identity.name)
        yield* exec(sql`UPDATE users SET google_sub = ${identity.sub} WHERE id = ${user.id}`)
        return user
      })

      const registerDevice = Effect.fn("Users.registerDevice")(function* (userId: UserId, device: RegisterDevice) {
        const now = yield* nowIso
        // A device id is the install; if it moved to another account, it now belongs to this one.
        yield* exec(sql`
          INSERT INTO devices (id, user_id, platform, apns_token, push_to_start_token, time_zone, app_version, updated_at)
          VALUES (${device.deviceId}, ${userId}, 'ios', ${orNull(device.apnsToken)}, ${orNull(device.pushToStartToken)},
                  ${device.timeZone}, ${orNull(device.appVersion)}, ${now})
          ON CONFLICT (id) DO UPDATE SET
            user_id = excluded.user_id,
            apns_token = COALESCE(excluded.apns_token, devices.apns_token),
            push_to_start_token = COALESCE(excluded.push_to_start_token, devices.push_to_start_token),
            time_zone = excluded.time_zone,
            app_version = COALESCE(excluded.app_version, devices.app_version),
            updated_at = excluded.updated_at`)
        // A push token is unique to an install; drop it from any other row that still has it.
        if (device.apnsToken !== undefined) {
          yield* exec(
            sql`UPDATE devices SET apns_token = NULL WHERE apns_token = ${device.apnsToken} AND id != ${device.deviceId}`
          )
        }
        yield* exec(sql`UPDATE users SET time_zone = ${device.timeZone} WHERE id = ${userId}`)
        const row = yield* sql`SELECT * FROM devices WHERE id = ${device.deviceId}`.pipe(decodeFirst(DeviceRow))
        return toDevice(row!)
      })

      const unregisterDevice = (userId: UserId, deviceId: DeviceId) =>
        exec(sql`DELETE FROM devices WHERE id = ${deviceId} AND user_id = ${userId}`)

      const devices = (userId: UserId) =>
        sql`SELECT * FROM devices WHERE user_id = ${userId} ORDER BY updated_at DESC`.pipe(
          decodeRows(DeviceRow),
          Effect.map((rows) => rows.map(toDevice))
        )

      const forgetApnsToken = (token: string) =>
        exec(sql`UPDATE devices SET apns_token = NULL WHERE apns_token = ${token}`)
      const forgetPushToStartToken = (token: string) =>
        exec(sql`UPDATE devices SET push_to_start_token = NULL WHERE push_to_start_token = ${token}`)

      return Users.of({
        find,
        findByEmail,
        isInvited,
        invite,
        upsertGoogle,
        upsertByEmail,
        registerDevice,
        unregisterDevice,
        devices,
        forgetApnsToken,
        forgetPushToStartToken
      })
    })
  )
}
