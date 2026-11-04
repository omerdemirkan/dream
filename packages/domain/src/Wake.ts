/**
 * Wake-ups the agent schedules with `dream wake --at|--cron`. The ProjectDO
 * keeps them and fires them from alarms.
 */
import { Schema } from "effect"
import { WakeId } from "./Ids.ts"
import { TimeZone } from "./User.ts"

export const WakeWhen = Schema.TaggedUnion({
  At: { at: Schema.DateTimeUtc },
  /** Five-field cron. `timeZone` defaults to theirs, so "0 7 * * *" means 7:00 where they are. */
  Cron: { expression: Schema.NonEmptyString, timeZone: Schema.optionalKey(TimeZone) }
})
export type WakeWhen = typeof WakeWhen.Type

export const Wake = Schema.Struct({
  id: WakeId,
  when: WakeWhen,
  why: Schema.NonEmptyString,
  /**
   * A shell command dreamd runs when the wake fires. The agent is only woken
   * if it exits non-zero. Without a command the agent is woken directly.
   */
  run: Schema.optionalKey(Schema.NonEmptyString),
  /** Absent once a one-off wake has fired. */
  nextAt: Schema.optionalKey(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc
})
export type Wake = typeof Wake.Type
