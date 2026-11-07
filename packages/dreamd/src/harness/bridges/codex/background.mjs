/**
 * Codex subagents as part of a turn: Dream's addition to the adapter's bridge (`Bridges.ts` installs this file beside
 * `bridge.mjs` and patches the bridge's app-server driver to use it).
 *
 * A child agent Codex's `spawn_agent` starts runs in the app-server on a thread of its own, and when the root
 * agent's turn completes it keeps running, but nothing tells the root when it's done: Codex never starts a root turn
 * for it, and its final answer waits in the root's mailbox until the root calls `wait_agent`. The adapter ends the
 * turn when the root's completes, so the sandbox goes to sleep with the child in it, or its answer goes unread.
 *
 * Here the turn is held instead. The app-server reports each child on the root's thread (`subAgentActivity` items:
 * `started`, then `completed`); when the root's turn completes with children still running, or with answers it never
 * collected (`FINAL_ANSWER` messages its mailbox didn't deliver), the driver waits for them and then starts another
 * root turn whose input hands over their final answers. A message steered in while it waits starts that turn at
 * once. The turn ends when the root completes one with nothing running and nothing left to hand over.
 *
 * While held, the bridge tells dreamd what it waits on with a `raw` part (`report`), as the Claude Code bridge does.
 * Plain JavaScript, Node built-ins only, since the bridge runs it as is.
 */

/** The `type` of the `raw` value `report` gives dreamd. */
export const reportType = "dream_background"

/** The most of one child's final answer handed over in a turn's input; the rest is in its thread. */
const answerLimit = 20000

const record = (value) => (value != null && typeof value === "object" && !Array.isArray(value) ? value : undefined)

const textOf = (content) =>
  Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
    : typeof content === "string"
      ? content
      : ""

/**
 * @param {{ now?: () => number, activityEveryMs?: number }} [options]
 */
export function createDreamChildren({ now = Date.now, activityEveryMs = 60000 } = {}) {
  /** Running children, by thread id. */
  const live = new Map()
  /** Children whose final answer the root hasn't seen: path → text. */
  const unread = new Map()
  /** Each child's latest message, by thread id. */
  const lastText = new Map()
  /** Children whose final answer the root's mailbox delivered, by path. */
  const delivered = new Set()
  /** Messages steered in while the root waits. */
  const steered = []
  /** Whether the root's turn is over and the driver waits on its children. */
  let holding = false
  let wake = () => {}
  let lastActivity = 0
  /** A child did something since the last report. */
  let active = false
  let reported = ""

  const changed = () => {
    const resolve = wake
    wake = () => {}
    resolve()
  }

  return {
    /** Whether the driver waits on children: messages steered in now start the next root turn. */
    holding: () => holding,

    /** Note what an app-server notification says about the root's children. */
    observe(notification, rootThreadId) {
      const params = record(notification?.params)
      if (params == null || rootThreadId == null) return
      const item = record(params.item)
      if (params.threadId === rootThreadId) {
        if (notification.method === "item/completed" && item?.type === "subAgentActivity") {
          const id = item.agentThreadId
          if (typeof id !== "string") return
          const path = typeof item.agentPath === "string" ? item.agentPath : id
          if (item.kind === "started") {
            live.set(id, { id, type: "subagent", description: path })
          } else if (item.kind === "completed" || item.kind === "failed" || item.kind === "interrupted") {
            live.delete(id)
            if (!delivered.delete(path)) unread.set(path, lastText.get(id) ?? "")
          }
          changed()
          return
        }
        // The root's mailbox delivered a child's answer (`wait_agent`): it has read it.
        if (notification.method === "rawResponseItem/completed" && item?.type === "agent_message") {
          const text = textOf(item.content)
          const sender = /Sender: (\S+)/.exec(text)?.[1]
          if (sender !== undefined && text.includes("FINAL_ANSWER") && !unread.delete(sender)) delivered.add(sender)
        }
        return
      }
      if (typeof params.threadId !== "string") return
      if (notification.method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
        lastText.set(params.threadId, item.text)
      }
      if (holding && live.has(params.threadId) && now() - lastActivity >= activityEveryMs) {
        lastActivity = now()
        active = true
        changed()
      }
    },

    /** A message the person sent while the root waits: it goes into the next root turn. */
    steer(message) {
      steered.push(message)
      changed()
    },

    /**
     * After a root turn completed: wait, while children run and nothing is steered in, then say what the next
     * root turn gets (`input`, with the steered `messages` it carries), or undefined when the turn is over.
     * `onReport` hears what's being waited on whenever that changes.
     */
    async settle(onReport) {
      holding = true
      try {
        for (;;) {
          const report = this.report()
          if (report !== undefined) onReport(report)
          if (steered.length > 0 || (live.size === 0 && unread.size > 0)) break
          if (live.size === 0) return undefined
          await new Promise((resolve) => {
            wake = resolve
          })
        }
        const messages = steered.splice(0)
        const answers = [...unread.entries()]
        unread.clear()
        const parts = []
        if (answers.length > 0) {
          parts.push(
            [
              "Dream kept your turn going until your subagents reported back. Their final answers:",
              ...answers.map(([path, text]) => {
                const clipped = text.length > answerLimit ? `${text.slice(0, answerLimit)}\n[cut short]` : text
                return `${path}:\n${clipped.trim() === "" ? "(it gave no final answer)" : clipped}`
              }),
              "Codex may hand you the same answers again from your mailbox."
            ].join("\n\n")
          )
        }
        for (const message of messages) parts.push(message.text)
        return { input: parts.join("\n\n"), messages }
      } finally {
        holding = false
        const report = this.report()
        if (report !== undefined) onReport(report)
      }
    },

    /** For dreamd, when it changed: the running children, and whether the turn is held for them. */
    report() {
      const value = { type: reportType, holding: holding && live.size > 0, live: [...live.values()] }
      const key = JSON.stringify(value)
      const activity = active
      active = false
      if (key === reported && !activity) return undefined
      reported = key
      return activity ? { ...value, activity: true } : value
    }
  }
}

/** Two usages (the bridge's `mapUsage` shape) added, number by number. */
export function addUsage(total, usage) {
  if (total == null) return usage
  if (usage == null) return total
  const sum = { ...total }
  for (const [key, value] of Object.entries(usage)) {
    const previous = sum[key]
    sum[key] =
      typeof value === "number" && typeof previous === "number"
        ? previous + value
        : record(value) && record(previous)
          ? addUsage(previous, value)
          : (value ?? previous)
  }
  return sum
}
