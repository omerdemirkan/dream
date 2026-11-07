/** Types for `background.mjs`, which the Codex bridge runs as plain JavaScript. */

export declare const reportType: "dream_background"

export interface ChildReport {
  readonly type: typeof reportType
  readonly holding: boolean
  readonly live: ReadonlyArray<{ readonly id: string; readonly type: "subagent"; readonly description: string }>
  readonly activity?: true
}

export interface SteeredMessage {
  readonly text: string
  readonly accept: () => void
  readonly reject: (error: unknown) => void
}

export interface DreamChildren {
  readonly holding: () => boolean
  readonly observe: (
    notification: { readonly method: string; readonly params?: unknown },
    rootThreadId: string | undefined
  ) => void
  readonly steer: (message: SteeredMessage) => void
  readonly settle: (
    onReport: (report: ChildReport) => void
  ) => Promise<{ readonly input: string; readonly messages: ReadonlyArray<SteeredMessage> } | undefined>
  readonly report: () => ChildReport | undefined
}

export declare function createDreamChildren(options?: {
  readonly now?: () => number
  readonly activityEveryMs?: number
}): DreamChildren

export declare function addUsage<U>(total: U | undefined, usage: U | undefined): U
