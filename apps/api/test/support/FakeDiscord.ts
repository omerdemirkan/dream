/**
 * A fake Discord: the Gateway protocol as https://docs.discord.com/developers/events/gateway describes it, and the
 * one REST call a bot makes before connecting (`GET /gateway/bot`). Transport-agnostic, so the unit tests drive it
 * over in-memory sockets and `scripts/fake-discord.ts` serves it over real WebSockets for the end-to-end check.
 *
 * - On connect it sends Hello. Identify with the right token and allowed intents gets READY (a new session, with a
 *   resume URL); a wrong token closes with 4004, intents it doesn't allow with 4014.
 * - Heartbeats are acknowledged (unless `acking` is off), and must carry the last sequence number.
 * - Resume with a known session replays the dispatches after the given sequence, then RESUMED; an unknown or expired
 *   session gets Invalid Session (`d: false`).
 * - Controls let a test dispatch events, drop the line, ask for a reconnect, invalidate the session, expire it, or
 *   stop acknowledging heartbeats, and it records what the client did.
 */

export interface GatewayConnection {
  readonly send: (text: string) => void
  readonly close: (code: number, reason: string) => void
}

export interface FakeDiscordOptions {
  readonly token: string
  /** Where clients connect (without the query), e.g. wss://gateway.discord.test. */
  readonly gatewayUrl: string
  readonly resumeUrl?: string
  readonly heartbeatInterval?: number
  /** Intents beyond these get 4014. Default: everything. */
  readonly allowedIntents?: number
  readonly bot?: { readonly id: string; readonly username: string }
}

interface Session {
  readonly id: string
  /** Every dispatch, in order, with its sequence number. */
  readonly log: Array<{ readonly s: number; readonly t: string; readonly d: unknown }>
  seq: number
  expired: boolean
}

interface Live {
  readonly connection: GatewayConnection
  session: Session | undefined
  closed: boolean
}

export class FakeDiscord {
  readonly options: Required<Omit<FakeDiscordOptions, "allowedIntents">> & { readonly allowedIntents: number }
  readonly sessions = new Map<string, Session>()
  readonly live = new Set<Live>()
  /** What clients did, in order: "connect", "identify <intents>", "resume <session> <seq>", "heartbeat <seq>", "close". */
  readonly calls: Array<string> = []
  acking = true
  /** `GET /gateway/bot` answers this status instead (e.g. 429, 500), while set. */
  restStatus: number | undefined = undefined
  sessionStartsRemaining = 1000
  private counter = 0

  constructor(options: FakeDiscordOptions) {
    this.options = {
      resumeUrl: options.gatewayUrl.replace("://", "://resume."),
      heartbeatInterval: 41_250,
      allowedIntents: Number.MAX_SAFE_INTEGER,
      bot: { id: "1000", username: "Helper" },
      ...options
    }
  }

  /** `GET /gateway/bot`. */
  gatewayBot(authorization: string | undefined): { readonly status: number; readonly body: unknown } {
    if (this.restStatus !== undefined) return { status: this.restStatus, body: { message: "nope", retry_after: 2 } }
    if (authorization !== `Bot ${this.options.token}`)
      return { status: 401, body: { message: "401: Unauthorized", code: 0 } }
    return {
      status: 200,
      body: {
        url: this.options.gatewayUrl,
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: this.sessionStartsRemaining,
          reset_after: 60_000,
          max_concurrency: 1
        }
      }
    }
  }

  /** A client connected; returns what to call with each message it sends, and when it goes. */
  open(connection: GatewayConnection): { readonly receive: (text: string) => void; readonly closed: () => void } {
    const live: Live = { connection, session: undefined, closed: false }
    this.live.add(live)
    this.calls.push("connect")
    this.send(live, { op: 10, d: { heartbeat_interval: this.options.heartbeatInterval } })
    return {
      receive: (text) => this.receive(live, text),
      closed: () => {
        if (live.closed) return
        live.closed = true
        this.live.delete(live)
        this.calls.push("close")
      }
    }
  }

  private send(live: Live, payload: unknown) {
    if (!live.closed) live.connection.send(JSON.stringify(payload))
  }

  private close(live: Live, code: number, reason: string) {
    if (live.closed) return
    live.closed = true
    this.live.delete(live)
    live.connection.close(code, reason)
  }

  private receive(live: Live, text: string) {
    let payload: { op: number; d?: any }
    try {
      payload = JSON.parse(text)
    } catch {
      return this.close(live, 4002, "Decode error")
    }
    switch (payload.op) {
      case 1: {
        this.calls.push(`heartbeat ${payload.d}`)
        if (this.acking) this.send(live, { op: 11 })
        return
      }
      case 2: {
        const { token, intents } = payload.d ?? {}
        this.calls.push(`identify ${intents}`)
        if (token !== this.options.token) return this.close(live, 4004, "Authentication failed.")
        if ((intents & ~this.options.allowedIntents) !== 0) return this.close(live, 4014, "Disallowed intent(s).")
        const session: Session = { id: `session-${++this.counter}`, log: [], seq: 0, expired: false }
        this.sessions.set(session.id, session)
        live.session = session
        this.sessionStartsRemaining--
        this.dispatchTo(live, session, "READY", {
          v: 10,
          session_id: session.id,
          resume_gateway_url: this.options.resumeUrl,
          user: { id: this.options.bot.id, username: this.options.bot.username, discriminator: "0", bot: true },
          guilds: []
        })
        return
      }
      case 6: {
        const { token, session_id, seq } = payload.d ?? {}
        this.calls.push(`resume ${session_id} ${seq}`)
        if (token !== this.options.token) return this.close(live, 4004, "Authentication failed.")
        const session = this.sessions.get(session_id)
        if (session === undefined || session.expired) return this.send(live, { op: 9, d: false })
        live.session = session
        for (const entry of session.log)
          if (entry.s > seq) this.send(live, { op: 0, s: entry.s, t: entry.t, d: entry.d })
        this.dispatchTo(live, session, "RESUMED", {})
        return
      }
      default:
        return
    }
  }

  private dispatchTo(live: Live | undefined, session: Session, t: string, d: unknown) {
    session.seq++
    session.log.push({ s: session.seq, t, d })
    if (live !== undefined) this.send(live, { op: 0, s: session.seq, t, d })
  }

  /** The newest session, if any client ever identified. */
  get session(): Session | undefined {
    return [...this.sessions.values()].at(-1)
  }

  /**
   * A dispatch on the newest session: sent now if its client is connected, else kept for a resume to replay. Returns
   * its sequence number.
   */
  dispatch(t: string, d: unknown): number {
    const session = this.session
    if (session === undefined) throw new Error("No session to dispatch on")
    const live = [...this.live].find((each) => each.session === session)
    this.dispatchTo(live, session, t, d)
    return session.seq
  }

  /** A message in a server channel, from someone, as Discord sends MESSAGE_CREATE. */
  message(
    content: string,
    options: {
      readonly author?: string
      readonly channel?: string
      readonly guild?: string | null
      readonly mentionsBot?: boolean
    } = {}
  ): number {
    const id = String(2_000_000 + this.counter++)
    return this.dispatch("MESSAGE_CREATE", {
      id,
      channel_id: options.channel ?? "300",
      ...(options.guild === null ? {} : { guild_id: options.guild ?? "200" }),
      author: { id: options.author ?? "500", username: "someone" },
      content,
      mentions: options.mentionsBot === true ? [{ id: this.options.bot.id, username: this.options.bot.username }] : [],
      timestamp: new Date(0).toISOString()
    })
  }

  /** Drops every live line, with `code` (as a server would), or as a network failure (1006, no reason). */
  drop(code = 1006, reason = ""): void {
    for (const live of [...this.live]) this.close(live, code, reason)
  }

  /** Op 7: asks every client to reconnect and resume. */
  requestReconnect(): void {
    for (const live of this.live) this.send(live, { op: 7, d: null })
  }

  /** Op 9: tells every client its session is invalid; `resumable` says whether it may resume. */
  invalidate(resumable: boolean): void {
    for (const live of this.live) {
      if (!resumable && live.session !== undefined) live.session.expired = true
      this.send(live, { op: 9, d: resumable })
    }
  }

  /** The newest session times out, as Discord's do a few minutes after the line drops. */
  expire(): void {
    if (this.session !== undefined) this.session.expired = true
  }

  /** Lines currently open. */
  get connected(): number {
    return this.live.size
  }
}
