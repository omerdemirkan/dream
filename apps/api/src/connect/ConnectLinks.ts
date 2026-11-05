/**
 * One-time links for connecting a model subscription by pasting a token in a
 * browser (`CreateConnectLink`), so the token goes from their browser straight
 * to the Worker. The ticket is a signed token bound to the person; its id is
 * recorded in D1 and marked used when the page is submitted.
 */
import { type ConnectLink, type ConnectLinkProvider, InvalidRequest, Routes, type UserId } from "@dream/domain"
import { Clock, Context, Data, DateTime, Effect, Layer, Redacted } from "effect"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Connections } from "../db/Connections.ts"
import { randomToken } from "../lib/Ids.ts"
import { isClaudeToken, ModelConnect } from "./ModelConnect.ts"

/** Why a link can't be used: a bad signature or unknown ticket, past its 15 minutes, or already submitted. */
export class ConnectLinkUnusable extends Data.TaggedError("ConnectLinkUnusable")<{
  readonly reason: "invalid" | "expired" | "used"
}> {}

export class ConnectLinks extends Context.Service<
  ConnectLinks,
  {
    readonly create: (userId: UserId, provider: ConnectLinkProvider) => Effect.Effect<ConnectLink>
    /** Whether the link for `provider` can still be used. */
    readonly check: (provider: ConnectLinkProvider, ticket: string) => Effect.Effect<void, ConnectLinkUnusable>
    /** Uses the ticket up and stores the token as their connected subscription. */
    readonly redeem: (
      provider: ConnectLinkProvider,
      ticket: string,
      token: Redacted.Redacted<string>
    ) => Effect.Effect<void, ConnectLinkUnusable | InvalidRequest>
  }
>()("@dream/api/ConnectLinks") {
  static readonly layer = Layer.effect(
    ConnectLinks,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const tokens = yield* Tokens
      const connections = yield* Connections
      const modelConnect = yield* ModelConnect

      const create = Effect.fn("ConnectLinks.create")(function* (userId: UserId, provider: ConnectLinkProvider) {
        const ticketId = `ctk_${randomToken(22)}`
        const { token, expiresAtMs } = yield* tokens.connectTicket({ userId, provider, ticketId })
        yield* connections.putConnectTicket({ id: ticketId, userId, provider, expiresAtMs })
        return {
          url: `${config.apiUrl}${Routes.connect(provider)}?t=${encodeURIComponent(token)}`,
          expiresAt: DateTime.makeUnsafe(expiresAtMs)
        }
      })

      /** The ticket's claims, if it is for `provider`, signed, unexpired and unused. */
      const usable = (provider: ConnectLinkProvider, ticket: string, nowMs: number) =>
        Effect.gen(function* () {
          const claims = yield* tokens
            .verifyConnectTicket(ticket)
            .pipe(
              Effect.mapError(
                (error) => new ConnectLinkUnusable({ reason: error.reason === "expired" ? "expired" : "invalid" })
              )
            )
          if (claims.provider !== provider) return yield* new ConnectLinkUnusable({ reason: "invalid" })
          if (!(yield* connections.connectTicketUsable(claims.ticketId, claims.userId, nowMs))) {
            return yield* new ConnectLinkUnusable({ reason: "used" })
          }
          return claims
        })

      const check = Effect.fn("ConnectLinks.check")(function* (provider: ConnectLinkProvider, ticket: string) {
        yield* usable(provider, ticket, yield* Clock.currentTimeMillis)
      })

      const redeem = Effect.fn("ConnectLinks.redeem")(function* (
        provider: ConnectLinkProvider,
        ticket: string,
        token: Redacted.Redacted<string>
      ) {
        const now = yield* Clock.currentTimeMillis
        const claims = yield* usable(provider, ticket, now)
        // Checked before the ticket is used up, so a mistyped paste can be fixed on the same page.
        const trimmed = Redacted.value(token).trim()
        if (!isClaudeToken(trimmed)) {
          return yield* new InvalidRequest({
            message: "That doesn't look like a Claude token. It starts with sk-ant-oat; paste the whole line."
          })
        }
        if (!(yield* connections.useConnectTicket(claims.ticketId, claims.userId, now))) {
          return yield* new ConnectLinkUnusable({ reason: "used" })
        }
        yield* modelConnect.connectToken(claims.userId, Redacted.make(trimmed))
      })

      return ConnectLinks.of({ create, check, redeem })
    })
  )
}
