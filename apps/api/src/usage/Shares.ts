/**
 * Each project's estimated share of a subscription window, from how the window moved while its turns ran.
 *
 * Claude and ChatGPT only say how full a whole window is. Dream records, for every turn, the window's used percent
 * before (the latest reading when the turn started) and after (the latest when it finished), and the turn's tokens.
 * The rise across a turn is credited to it. Turns that overlap (several projects working at once) all see the same
 * rise, so they are grouped and the group's rise is split once, weighted by what each turn cost. Whatever the window
 * rose by outside Dream's turns is "Outside Dream".
 *
 * Where this is wrong, and which way:
 * - A stale "before". dreamd reports usage after each turn, so "before" is usually the reading the previous turn
 *   left. If they used Claude elsewhere (claude.ai, a CLI) since then, that use rises the window during the next
 *   turn's span and is credited to the turn: the project's share is too high and Outside Dream too low. Chaining
 *   groups (a group's "before" is never older than the previous group's "after") keeps this from double counting,
 *   but can't tell their own use apart.
 * - Outside use during a turn is credited to the turn for the same reason.
 * - A missing "after" (dreamd didn't report usage at the end) leaves the reading the turn started with: the turn
 *   gets nothing, and its use shows up as Outside Dream (or in the next turn) until a reading arrives.
 * - A window that rolled over mid-group: only the part after the reset is known (it counts from 0), so the group is
 *   credited with that part only, and turns that ran wholly before the reset share in it.
 * - Weights. Claude Code's `costUsd` tracks what the limits meter best; token prices are a stand-in, and turns from
 *   dreamd builds that report no tokens get the group's mean weight, a guess.
 * - Providers round percentages (often to whole numbers), so a short turn may see no rise at all.
 */
import type { ModelProvider, ProjectId, TokenUsage, UsageWindowName } from "@dream/domain"

/** One window as a usage snapshot reported it. */
export interface WindowReading {
  readonly usedPercent: number
  readonly resetsAtMs?: number | undefined
  readonly observedAtMs: number
}

export interface TurnRecord {
  readonly id: string
  readonly projectId: ProjectId
  readonly startedMs: number
  readonly endedMs: number
  /** Absent from dreamd builds that predate per-turn usage. */
  readonly tokens?: TokenUsage | undefined
  readonly costUsd?: number | undefined
  readonly before: Partial<Record<UsageWindowName, WindowReading>>
  readonly after: Partial<Record<UsageWindowName, WindowReading>>
}

export const WindowLength: Record<UsageWindowName, number> = {
  fiveHour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
}

/**
 * Two readings belong to the same window instance when their reset times are this close. A new instance resets at
 * least a window length after the last one, and Codex's reset times jitter by seconds (it reports seconds-to-reset).
 */
const SameResetWithin = 30 * 60 * 1000

/**
 * What each kind of token costs relative to fresh input, at list prices (Claude: cache writes 1.25×, reads 0.1×,
 * output 5×; OpenAI: cached input 0.1×, output 8×, no write premium). Only ratios matter: weights are compared
 * within one provider's group.
 */
export const RelativePrice: Record<ModelProvider, Record<keyof TokenUsage, number>> = {
  claude: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  chatgpt: { input: 1, cacheWrite: 1, cacheRead: 0.1, output: 8 }
}

/** The headline token figure: input, cache writes and output. Cache reads, which dwarf them, are counted apart. */
export const totalTokens = (tokens: TokenUsage): number => tokens.input + tokens.cacheWrite + tokens.output

const pricedTokens = (provider: ModelProvider, tokens: TokenUsage): number => {
  const price = RelativePrice[provider]
  return (
    tokens.input * price.input +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite * price.cacheWrite +
    tokens.output * price.output
  )
}

/** The window as Dream knows it now, from the latest snapshot. */
export interface CurrentWindow {
  readonly usedPercent: number
  /** When the current instance resets; absent when the provider doesn't say, or the known one has passed. */
  readonly resetsAtMs?: number | undefined
  /** Where the current instance began (or, when that isn't known, a window length ago). */
  readonly startMs: number
  /** The last known instance has reset and no reading of the new one has arrived: nothing is known of it yet. */
  readonly rolledOver: boolean
}

/** `reading` (from the latest snapshot) as of `nowMs`. A reset that has passed means an empty, unknown instance. */
export const currentWindow = (
  window: UsageWindowName,
  reading: WindowReading | undefined,
  nowMs: number
): CurrentWindow | undefined => {
  if (reading === undefined) return undefined
  const length = WindowLength[window]
  if (reading.resetsAtMs === undefined) {
    return { usedPercent: reading.usedPercent, startMs: nowMs - length, rolledOver: false }
  }
  if (reading.resetsAtMs <= nowMs) return { usedPercent: 0, startMs: reading.resetsAtMs, rolledOver: true }
  return {
    usedPercent: reading.usedPercent,
    resetsAtMs: reading.resetsAtMs,
    startMs: reading.resetsAtMs - length,
    rolledOver: false
  }
}

export interface WindowAttribution {
  /** Each turn's estimated share of the current instance, in percent of the whole window. Only turns in it appear. */
  readonly byTurn: ReadonlyMap<string, number>
  readonly byProject: ReadonlyMap<ProjectId, number>
  /** The current used percent minus every project's share, floored at 0. */
  readonly outsideDream: number
}

const latest = (readings: ReadonlyArray<WindowReading | undefined>): WindowReading | undefined =>
  readings.reduce<WindowReading | undefined>(
    (best, r) => (r !== undefined && (best === undefined || r.observedAtMs > best.observedAtMs) ? r : best),
    undefined
  )

const earliest = (readings: ReadonlyArray<WindowReading | undefined>): WindowReading | undefined =>
  readings.reduce<WindowReading | undefined>(
    (best, r) => (r !== undefined && (best === undefined || r.observedAtMs < best.observedAtMs) ? r : best),
    undefined
  )

const sameReset = (a: number | undefined, b: number | undefined): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= SameResetWithin

/** Turns whose spans overlap, transitively, in start order. */
export const groupOverlapping = (turns: ReadonlyArray<TurnRecord>): ReadonlyArray<ReadonlyArray<TurnRecord>> => {
  const sorted = [...turns].sort((a, b) => a.startedMs - b.startedMs || a.endedMs - b.endedMs)
  const groups: Array<Array<TurnRecord>> = []
  let end = -Infinity
  for (const turn of sorted) {
    const last = groups[groups.length - 1]
    if (last !== undefined && turn.startedMs < end) {
      last.push(turn)
      end = Math.max(end, turn.endedMs)
    } else {
      groups.push([turn])
      end = turn.endedMs
    }
  }
  return groups
}

/**
 * Cost weights for one group's turns: Claude Code's `costUsd` when every turn has it, else tokens at relative list
 * prices. A turn with neither (an older dreamd) still caused part of the rise, so it gets the mean of the others;
 * if no turn has one, or they're all zero, every turn weighs the same.
 */
export const costWeights = (provider: ModelProvider, group: ReadonlyArray<TurnRecord>): ReadonlyArray<number> => {
  const allCost = group.every((t) => t.costUsd !== undefined)
  const raw = group.map((t) =>
    allCost ? t.costUsd : t.tokens === undefined ? undefined : pricedTokens(provider, t.tokens)
  )
  const known = raw.filter((w): w is number => w !== undefined)
  const sum = known.reduce((a, b) => a + b, 0)
  if (known.length === 0 || sum <= 0) return group.map(() => 1)
  const mean = sum / known.length
  return raw.map((w) => w ?? mean)
}

/**
 * The rise of `window` across a group: the latest "after" minus the reading it started from. That reading is the
 * group's earliest "before", unless an earlier group's "after" is newer (it already counted up to there). A "before"
 * from an instance that has since reset counts from 0, as does a missing one when the instance began during the
 * group; a drop is never a negative rise. `undefined` when the rise can't be known.
 */
const groupRise = (
  window: UsageWindowName,
  group: ReadonlyArray<TurnRecord>,
  previousAfter: WindowReading | undefined
): { readonly rise: number; readonly after: WindowReading } | undefined => {
  const after = latest(group.map((t) => t.after[window]))
  if (after === undefined) return undefined
  const ownBefore = earliest(group.map((t) => t.before[window]))
  const before =
    previousAfter !== undefined &&
    previousAfter.observedAtMs <= after.observedAtMs &&
    (ownBefore === undefined || previousAfter.observedAtMs > ownBefore.observedAtMs)
      ? previousAfter
      : ownBefore
  const startedMs = Math.min(...group.map((t) => t.startedMs))
  let base: number
  if (before === undefined) {
    // No reading before it: knowable only if this instance began while the group ran (it began at 0).
    if (after.resetsAtMs === undefined || after.resetsAtMs - WindowLength[window] < startedMs - SameResetWithin) {
      return undefined
    }
    base = 0
  } else if (before.resetsAtMs !== undefined && after.resetsAtMs !== undefined) {
    base = sameReset(before.resetsAtMs, after.resetsAtMs) ? before.usedPercent : 0
  } else if (before.resetsAtMs !== undefined && before.resetsAtMs <= after.observedAtMs) {
    base = 0
  } else if (after.usedPercent < before.usedPercent && before.resetsAtMs === undefined) {
    // Within an instance the percentage only grows; with no reset times to go by, a drop means it reset.
    base = 0
  } else {
    base = before.usedPercent
  }
  return { rise: Math.max(0, Math.min(100, after.usedPercent - base)), after }
}

/** Whether a group's latest reading belongs to the current instance. */
const inCurrent = (current: CurrentWindow, after: WindowReading, endedMs: number): boolean => {
  if (current.rolledOver) return false
  if (current.resetsAtMs !== undefined && after.resetsAtMs !== undefined) {
    return sameReset(current.resetsAtMs, after.resetsAtMs)
  }
  return endedMs > current.startMs
}

/**
 * Splits `window`'s current instance across `turns` (all of one person's turns on one provider, any project, in
 * any order; turns from before the instance are ignored). Shares are clamped so they never add up to more than the
 * window's used percent.
 */
export const attributeWindow = (input: {
  readonly provider: ModelProvider
  readonly window: UsageWindowName
  readonly turns: ReadonlyArray<TurnRecord>
  readonly current: CurrentWindow
}): WindowAttribution => {
  const { provider, window, current } = input
  const byTurn = new Map<string, number>()
  let previousAfter: WindowReading | undefined
  for (const group of groupOverlapping(input.turns)) {
    const measured = groupRise(window, group, previousAfter)
    if (measured === undefined) continue
    previousAfter = latest([previousAfter, measured.after])
    const endedMs = Math.max(...group.map((t) => t.endedMs))
    if (!inCurrent(current, measured.after, endedMs)) continue
    const weights = costWeights(provider, group)
    const total = weights.reduce((a, b) => a + b, 0)
    group.forEach((turn, i) => byTurn.set(turn.id, (measured.rise * (weights[i] ?? 0)) / total))
  }
  const credited = [...byTurn.values()].reduce((a, b) => a + b, 0)
  if (credited > current.usedPercent) {
    const scale = credited === 0 ? 0 : current.usedPercent / credited
    for (const [id, share] of byTurn) byTurn.set(id, share * scale)
  }
  const projectOf = new Map(input.turns.map((t) => [t.id, t.projectId]))
  const byProject = new Map<ProjectId, number>()
  for (const [id, share] of byTurn) {
    const projectId = projectOf.get(id)
    if (projectId !== undefined) byProject.set(projectId, (byProject.get(projectId) ?? 0) + share)
  }
  const dream = [...byProject.values()].reduce((a, b) => a + b, 0)
  return { byTurn, byProject, outsideDream: Math.max(0, current.usedPercent - dream) }
}

/** A percentage for display: one decimal, within 0–100. */
export const roundPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value * 10) / 10))
