/**
 * Ids the API generates: `<prefix>_<22 random base62 chars>` (about 131 bits),
 * so they read well in logs and in `dream` commands.
 */
import {
  BrowserSessionId,
  EventId,
  IdPrefix,
  IntegrationId,
  MediaId,
  MessageId,
  ModelConnectionId,
  NotificationId,
  ProjectId,
  UserId,
  WakeId
} from "@dream/domain"
import { Effect, Schema } from "effect"

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export const randomToken = (length: number, chars: string = alphabet): string => {
  const out: Array<string> = []
  // Rejection sampling keeps the distribution uniform.
  const limit = 256 - (256 % chars.length)
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out.push(chars[byte % chars.length]!)
    }
  }
  return out.join("")
}

const make =
  <S extends Schema.Codec<any, string, never, never>>(schema: S, prefix: string) =>
  (): Effect.Effect<S["Type"]> =>
    Effect.sync(() => Schema.decodeUnknownSync(schema)(`${prefix}_${randomToken(22)}`))

export const newUserId = make(UserId, IdPrefix.user)
export const newProjectId = make(ProjectId, IdPrefix.project)
export const newMessageId = make(MessageId, IdPrefix.message)
export const newMediaId = make(MediaId, IdPrefix.media)
export const newEventId = make(EventId, IdPrefix.event)
export const newWakeId = make(WakeId, IdPrefix.wake)
export const newIntegrationId = make(IntegrationId, IdPrefix.integration)
export const newModelConnectionId = make(ModelConnectionId, IdPrefix.modelConnection)
export const newBrowserSessionId = make(BrowserSessionId, IdPrefix.browserSession)
export const newSecretId = (): Effect.Effect<string> => Effect.sync(() => `sec_${randomToken(22)}`)
export const newNotificationId = (): Effect.Effect<NotificationId> =>
  Effect.sync(() => Schema.decodeUnknownSync(NotificationId)(crypto.randomUUID()))
