/** Types for `background.mjs`, which the bridge runs as plain JavaScript. */

export declare const quietType: "dream_background_quiet"
export declare const reportType: "dream_background"

export interface BackgroundTask {
  readonly id: string
  /** Claude Code's `task_type`: `local_agent`, `local_bash`, `monitor`, … */
  readonly type: string | undefined
  readonly description: string | undefined
}

export interface BackgroundReport {
  readonly type: typeof reportType
  readonly holding: boolean
  readonly live: ReadonlyArray<BackgroundTask>
}

export interface DreamBackground {
  readonly engaged: () => boolean
  readonly busy: () => boolean
  readonly live: () => ReadonlyArray<BackgroundTask>
  readonly report: () => BackgroundReport | undefined
  readonly observe: (msg: unknown) => void
  readonly result: () => void
  readonly endNow: (options?: { readonly graceOver?: boolean }) => boolean
  readonly forStream: <M>(msg: M) => M
  readonly watch: <M>(source: AsyncIterable<M>) => AsyncGenerator<M | { readonly type: typeof quietType }>
}

export declare function createDreamBackground(options?: {
  readonly graceMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (timer: never) => void
}): DreamBackground
