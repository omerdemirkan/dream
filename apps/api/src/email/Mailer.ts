/**
 * Email from Dream, through Cloudflare Email Service's `send_email` binding (no API key: the binding is the
 * credential). Dream sends only mail a person asked for, to the address on file from their sign-in. It's sent from
 * `dream@<MailDomain>`, the sending subdomain the Stack onboards (infra/alchemy.run.ts). Bodies are never logged.
 */
import { UpstreamFailure } from "@dream/domain"
import { Context, Effect, Layer } from "effect"
import { ApiConfig } from "../Config.ts"

/** The parts of the runtime `SendEmail` binding Dream uses. */
export interface SendEmailBinding {
  readonly send: (message: {
    readonly from: { readonly email: string; readonly name: string }
    readonly to: string
    readonly subject: string
    readonly text: string
    readonly html: string
    readonly headers?: Record<string, string>
  }) => Promise<unknown>
}

export interface Mail {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html: string
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code.slice(0, 64)
    : undefined

/** The subdomain Dream sends from, under `DREAM_DOMAIN`. */
export const mailDomain = (domain: string) => `mail.${domain}`

export class Mailer extends Context.Service<
  Mailer,
  {
    /** Whether this deployment sends email at all (it has the binding). */
    readonly enabled: boolean
    readonly send: (mail: Mail) => Effect.Effect<void, UpstreamFailure>
  }
>()("@dream/api/Mailer") {
  /** Sends through the binding; without one (email isn't set up on this deployment) every send fails. */
  static readonly layer = (binding: SendEmailBinding | undefined) =>
    Layer.effect(
      Mailer,
      Effect.gen(function* () {
        const config = yield* ApiConfig
        const from = { email: `dream@${mailDomain(config.domain)}`, name: "Dream" }
        const send = Effect.fn("Mailer.send")(function* (mail: Mail) {
          if (binding === undefined) {
            return yield* new UpstreamFailure({ service: "Email", message: "email isn't set up on this deployment" })
          }
          yield* Effect.tryPromise({
            try: () =>
              binding.send({
                from,
                to: mail.to,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
                // Transactional, asked for: no unsubscribe list to join, and nothing for a mail client to auto-reply to.
                headers: { "Auto-Submitted": "auto-generated" }
              }),
            // Only the error's code (E_RECIPIENT_SUPPRESSED…): its message can echo the mail, and errors get logged.
            catch: (error) =>
              new UpstreamFailure({
                service: "Email",
                message: `couldn't send the email (${errorCode(error) ?? "no code"})`
              })
          })
        })
        return Mailer.of({ enabled: binding !== undefined, send })
      })
    )
}
