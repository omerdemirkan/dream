/**
 * Workstreams: the separate lines of work an agent runs at once in one project, each with a title and a one-line
 * "now" (`dream work`). They live on the Status card (`StatusCard.workstreams`), and messages carry the one they
 * belong to (`workstream` on every message).
 *
 * While two or more are active, the app shows the card's "now" sentence as one row per workstream (`cardRows`): a
 * row whose question or access request is open waits on them, in amber, at the top; past `RowsOnCard` the last row
 * sums up the rest; finished ones fold into one line. With one or none, the card is as it always was, and apps that
 * predate workstreams always show it that way. Added in November 2026; every field is additive.
 */
import { DateTime, Schema } from "effect"
import { MessageId, WorkstreamId } from "./Ids.ts"
import { fitLine } from "./Links.ts"
import { isOpenAsk, type Message } from "./Message.ts"

/** Longest title `dream work` takes. Far fewer fit on a row (`rowOnCard`). */
export const WorkstreamTitleMaxLength = 40

export const WorkstreamTitle = Schema.NonEmptyString.check(Schema.isMaxLength(WorkstreamTitleMaxLength))

/** `active` until the agent ends it: `done` folds into the card's last line, `dropped` leaves the card. */
export const WorkstreamState = Schema.Literals(["active", "done", "dropped"])
export type WorkstreamState = typeof WorkstreamState.Type

export const Workstream = Schema.Struct({
  id: WorkstreamId,
  /** What it is, in a few words: the row's first line ("Double charges"), and the label on its messages. */
  title: WorkstreamTitle,
  /** Where it stands, one short line under the title. */
  now: Schema.optionalKey(Schema.String),
  state: WorkstreamState,
  /** `done`: what came of it ("Fixed, refunds sent"), on the card's last line. `dropped`: why, for the agent. */
  result: Schema.optionalKey(Schema.String),
  startedAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  endedAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type Workstream = typeof Workstream.Type

/** A workstream as an event names it. */
export const WorkstreamRef = Schema.Struct({ id: WorkstreamId, title: Schema.String })
export type WorkstreamRef = typeof WorkstreamRef.Type

/** An open question or access request of a workstream, which makes its row wait on them. */
export const WorkstreamWait = Schema.Struct({ workstream: WorkstreamId, messageId: MessageId })
export type WorkstreamWait = typeof WorkstreamWait.Type

/** What `dream work` prints from: every workstream, and the open asks that make some of them wait. */
export const Workstreams = Schema.Struct({
  workstreams: Schema.Array(Workstream),
  waiting: Schema.Array(WorkstreamWait)
})
export type Workstreams = typeof Workstreams.Type

// ---------------------------------------------------------------------------
// On the card
// ---------------------------------------------------------------------------

/** Rows the card shows; with more active, the last of them sums up the rest. */
export const RowsOnCard = 3

/** How long a finished workstream stays on the card's last line. */
export const DoneOnCardDays = 3

/**
 * A row on a 6.3" iPhone: the title in 15.5 pt semibold and the now-line in 14 pt, each one line about 300 pt wide
 * beside the dot. Estimates like `nowOnCard`'s; past one line each is cut with "…".
 */
export const rowOnCard = (
  workstream: Pick<Workstream, "title" | "now">
): { readonly title: string; readonly now: string | undefined; readonly whole: boolean } => {
  const title = fitLine(workstream.title.replace(/\s+/g, " ").trim(), 290, 15.5)
  const now =
    workstream.now === undefined || workstream.now.trim() === ""
      ? undefined
      : fitLine(workstream.now.replace(/\s+/g, " ").trim(), 300, 14)
  return { title: title.shown, now: now?.shown, whole: title.whole && (now?.whole ?? true) }
}

/** Whether an ask needs them now (an access request for later doesn't yet). */
export const waitsOnThem = (message: Message): boolean =>
  isOpenAsk(message) && !(message._tag === "Access" && message.when !== undefined)

export interface CardRow {
  readonly workstream: Workstream
  /** The first of its open asks, while it waits on them. */
  readonly waitingOn?: MessageId | undefined
}

export interface CardRows {
  /** The rows, waiting ones first, then in the order they started. */
  readonly rows: ReadonlyArray<CardRow>
  /** Active ones past the cap, summed up in the last row. */
  readonly more: ReadonlyArray<CardRow>
  /** Finished in the last `DoneOnCardDays`, latest first, for the folded line. */
  readonly done: ReadonlyArray<Workstream>
}

/**
 * The card's rows, or `undefined` while fewer than two workstreams are active (the card shows its "now" sentence).
 * `waits` maps each open ask of a workstream to it; the oldest decides.
 */
export const cardRows = (
  workstreams: ReadonlyArray<Workstream> | undefined,
  waits: ReadonlyArray<{ readonly workstream: WorkstreamId; readonly messageId: MessageId }>,
  now: DateTime.Utc
): CardRows | undefined => {
  const active = (workstreams ?? []).filter((w) => w.state === "active")
  if (active.length < 2) return undefined
  const all = active
    .map((workstream, order): CardRow & { readonly order: number } => {
      const wait = waits.find((w) => w.workstream === workstream.id)
      return { workstream, waitingOn: wait?.messageId, order }
    })
    .sort((a, b) => {
      const waiting = (a.waitingOn === undefined ? 1 : 0) - (b.waitingOn === undefined ? 1 : 0)
      if (waiting !== 0) return waiting
      const started = DateTime.toEpochMillis(a.workstream.startedAt) - DateTime.toEpochMillis(b.workstream.startedAt)
      return started !== 0 ? started : a.order - b.order
    })
    .map(({ workstream, waitingOn }): CardRow => ({ workstream, waitingOn }))
  const shown = all.length <= RowsOnCard ? all : all.slice(0, RowsOnCard - 1)
  const since = DateTime.toEpochMillis(now) - DoneOnCardDays * 24 * 60 * 60 * 1000
  const done = (workstreams ?? [])
    .filter((w) => w.state === "done" && w.endedAt !== undefined && DateTime.toEpochMillis(w.endedAt) >= since)
    .sort((a, b) => DateTime.toEpochMillis(b.endedAt ?? b.updatedAt) - DateTime.toEpochMillis(a.endedAt ?? a.updatedAt))
  return { rows: shown, more: all.slice(shown.length), done }
}

/** The open asks that make workstreams wait, oldest first, from messages (oldest first). */
export const workstreamWaits = (
  messages: ReadonlyArray<Message>
): ReadonlyArray<{ readonly workstream: WorkstreamId; readonly messageId: MessageId }> =>
  messages.flatMap((m) =>
    m.workstream !== undefined && waitsOnThem(m) ? [{ workstream: m.workstream, messageId: m.id }] : []
  )

/** The summary row for active workstreams past the cap: "2 more: Android?, Onboarding". */
export const moreLine = (more: ReadonlyArray<CardRow>): string =>
  `${more.length} more: ${more.map((r) => r.workstream.title).join(", ")}`

/** The folded line for finished workstreams: "Double charges · Fixed, refunds sent", with how many others. */
export const doneLine = (
  done: ReadonlyArray<Workstream>
): { readonly text: string; readonly others: number } | undefined => {
  const latest = done[0]
  if (latest === undefined) return undefined
  const result = latest.result?.trim()
  const text = result === undefined || result === "" ? `${latest.title} · Done` : `${latest.title} · ${result}`
  return { text, others: done.length - 1 }
}
