/**
 * One Durable Object per project (SQLite-backed): chat, questions, status
 * card, schedules, sandbox state, Live Activity, sent notifications, and the
 * agent's event inbox. Alarms fire scheduled wakes; it also serves
 * `ProjectLiveRpcs` to the phone over a WebSocket.
 *
 * Skeleton only: the control-plane workstream fills this in.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"

export default class ProjectDO extends Cloudflare.DurableObject<ProjectDO>()(
  "ProjectDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    return Effect.gen(function* () {
      return {
        /** Placeholder RPC so the namespace has a typed stub. */
        ping: () => state.storage.get<number>("created").pipe(Effect.map(() => "pong" as const))
      }
    })
  })
) {}
