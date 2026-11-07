/**
 * Background work as part of a Claude Code turn: Dream's addition to the adapter's bridge (`Bridges.ts` installs
 * this file beside `bridge.mjs` and patches the bridge to use it).
 *
 * The adapter ends a turn at the first `result` that answers the prompt and then disposes of the query, which stops
 * the CLI. A subagent, shell or Monitor the model left running in the background dies with it, and its report never
 * reaches the model. In Claude Code itself the session stays open, and when background work reports back, the CLI
 * starts a model turn of its own for it (a `task_notification`, then a new `system`/`init`, then another `result`).
 * Here the turn is held the same way: while non-ambient background tasks are live (`background_tasks_changed`, a
 * level signal), a `result` doesn't end it, and the CLI's own follow-up turns come through as part of it, along with
 * anything steered in meanwhile. The turn ends at a `result` (or the session going idle) with nothing live.
 *
 * A task that finishes is followed by a model turn for its notification, but the set can empty a moment before that
 * turn starts, so with nothing live the end waits `graceMs` for one: if a model turn begins, its `result` ends the
 * turn instead, and if none does (the notification went into the turn that was already running), the turn ends.
 *
 * A turn that never had background work ends exactly as the adapter ends it. While one is held, the bridge tells
 * dreamd what it's waiting on with a `raw` part (`report`), which is what dreamd's limits on background work go by.
 * Plain JavaScript, Node built-ins only, since the bridge runs it as is.
 */

/** The `type` of the message `watch` yields when the grace period runs out. */
export const quietType = "dream_background_quiet"

/** The `type` of the `raw` value `report` gives dreamd. */
export const reportType = "dream_background"

/**
 * @param {{ graceMs?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [options]
 */
export function createDreamBackground({ graceMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  /** Live non-ambient background tasks, by id. */
  let live = new Map()
  /** Every task that was live this turn. */
  const seen = new Set()
  /** A task left the live set since the last model turn began. */
  let shrunk = false
  /** The model isn't in a turn: the last thing it did was finish one. */
  let resting = false
  /** What the last report said, so only changes are sent. */
  let reported = ""
  let timer
  let wake = () => {}
  let quiet = new Promise((resolve) => {
    wake = resolve
  })

  const disarm = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
  }
  const arm = () => {
    if (timer !== undefined) return
    timer = setTimer(() => {
      timer = undefined
      wake()
    }, graceMs)
    timer?.unref?.()
  }

  return {
    /** Whether background work ran this turn; if not, the adapter's own rules end it. */
    engaged: () => seen.size > 0,
    /** Background tasks are still running. */
    busy: () => live.size > 0,
    /** The live tasks, for logs. */
    live: () => [...live.values()],

    /**
     * For dreamd, when it changed since the last one: the live tasks, and whether the turn is held for them
     * (the model finished its turn and they're still running). Undefined when nothing changed.
     */
    report() {
      if (seen.size === 0) return undefined
      const value = { type: reportType, holding: resting && live.size > 0, live: [...live.values()] }
      const key = JSON.stringify(value)
      if (key === reported) return undefined
      reported = key
      return value
    },

    /** Note what a message from the CLI says about background work and the model's turns. */
    observe(msg) {
      if (msg?.type !== "system") return
      if (msg.subtype === "background_tasks_changed" && Array.isArray(msg.tasks)) {
        const next = new Map()
        for (const task of msg.tasks) {
          if (task == null || typeof task.task_id !== "string" || task.ambient === true) continue
          next.set(task.task_id, { id: task.task_id, type: task.task_type, description: task.description })
          seen.add(task.task_id)
        }
        const left = [...live.keys()].some((id) => !next.has(id))
        live = next
        if (left) shrunk = true
        // Nothing left, and the model is between turns: one for the last notification should start shortly.
        if (left && live.size === 0 && resting) arm()
        return
      }
      if (msg.subtype === "init" || (msg.subtype === "session_state_changed" && msg.state === "running")) {
        resting = false
        shrunk = false
        disarm()
        return
      }
      if (msg.subtype === "session_state_changed" && msg.state === "idle") resting = true
    },

    /** A `result` came: the model finished a turn. */
    result() {
      resting = true
    },

    /**
     * Whether the turn may end now, at a `result`, the session going idle, or (`graceOver`) the quiet message:
     * nothing is live, and no follow-up turn is still to come.
     */
    endNow({ graceOver = false } = {}) {
      if (live.size > 0) return false
      if (graceOver) return true
      if (timer !== undefined) return false
      if (shrunk) {
        arm()
        return false
      }
      return true
    },

    /**
     * A failed background task is the model's to deal with, as its notification says, not the turn's end: the
     * adapter takes a task failure with an error for a terminal one, so the error is left out of what it sees.
     */
    forStream(msg) {
      if (
        msg?.type === "system" &&
        msg.subtype === "task_updated" &&
        seen.has(msg.task_id) &&
        msg.patch?.status === "failed" &&
        typeof msg.patch.error === "string"
      ) {
        const { error: _, ...patch } = msg.patch
        return { ...msg, patch }
      }
      return msg
    },

    /** The CLI's messages, with a `quietType` message whenever the grace period runs out. */
    async *watch(source) {
      const iterator = source[Symbol.asyncIterator]()
      let pending
      try {
        for (;;) {
          pending ??= iterator.next()
          const next = await Promise.race([pending, quiet.then(() => quietType)])
          if (next === quietType) {
            quiet = new Promise((resolve) => {
              wake = resolve
            })
            yield { type: quietType }
            continue
          }
          pending = undefined
          if (next.done) return
          yield next.value
        }
      } finally {
        disarm()
        // Not awaited: with a message still pending, the generator can't return until the bridge disposes the query.
        void iterator.return?.()?.catch?.(() => {})
      }
    }
  }
}
