/**
 * Finishing an access request on a computer. On the card they tap "Email it to me" (`EmailAccessLink`), and Dream
 * emails the address on file from their sign-in a link to a page served here (http/DesktopPage.ts), where they
 * paste the key or sign in exactly as the phone would: through `Access`, into the same encrypted storage, and the
 * card turns Connected over the live stream.
 *
 * The link is a capability, so it is held to this:
 * - The emailed token is random (256 bits), rides in the URL fragment (never sent to a server, so it stays out of
 *   logs and referrers) and is stored only as a SHA-256 hash, bound to one person and one request.
 * - It opens once, within 30 minutes of being sent, when they press Continue (mail scanners that fetch links
 *   don't use it up). Opening it gives that one browser a session cookie (HttpOnly, SameSite=Strict) for 30
 *   minutes, kept only as a hash too. A second browser, or the email forwarded on, finds it used.
 * - It ends when the request stops waiting (connected, declined, gone), when a newer link replaces it, and once
 *   it has finished the request. Every page load and submission checks the request again.
 */
import {
  type AccessDesktop,
  type AccessMessage,
  accessHeading,
  canFinishOnDesktop,
  InvalidRequest,
  type MessageId,
  NotFound,
  type ProjectId,
  type UpstreamFailure,
  type UserId
} from "@dream/domain"
import { Clock, Context, Data, DateTime, Duration, Effect, Layer, Option, Redacted } from "effect"
import { ApiConfig } from "../Config.ts"
import { type DesktopLinkRow, DesktopLinks } from "../db/DesktopLinks.ts"
import { Projects } from "../db/Projects.ts"
import { Users } from "../db/Users.ts"
import { Mailer } from "../email/Mailer.ts"
import { Meter } from "../metering/Meter.ts"
import { Access } from "../integrations/Access.ts"
import { utf8 } from "../lib/Bytes.ts"
import { randomToken } from "../lib/Ids.ts"
import { ProjectClients } from "../project/Client.ts"
import { accessEmail } from "./Email.ts"

export const LinkLifetime = Duration.minutes(30)
export const SessionLifetime = Duration.minutes(30)
/** Sends per request, and in all, in an hour: enough to resend, not enough to flood an inbox. */
export const SendLimit = { perMessage: 5, perUser: 20 } as const

/** The OAuth `state` prefix of a sign-in started on a desktop page, naming its link. */
export const desktopStatePrefix = (linkId: string) => `dsk.${linkId}.`
/** The link a desktop sign-in's `state` names, if it is one. */
export const desktopLinkOfState = (state: string): string | undefined => /^dsk\.(dsk_[A-Za-z0-9]+)\./.exec(state)?.[1]

/** The cookie that holds a browser's session for one link. */
export const sessionCookie = (linkId: string) => `__Host-dream-${linkId}`

/** Why a link or session can't be used, which the page explains. */
export class DesktopLinkUnusable extends Data.TaggedError("DesktopLinkUnusable")<{
  readonly reason:
    | "invalid"
    | "expired"
    /** Opened in another browser already. */
    | "used"
    /** A newer link was sent for the same request. */
    | "replaced"
    /** It did its job. */
    | "finished"
    /** The request isn't waiting anymore. */
    | "closed"
  /** The card, when the request is still there, for the page to say what happened to it. */
  readonly message?: AccessMessage | undefined
}> {}

export interface DesktopSession {
  readonly link: DesktopLinkRow
  readonly message: AccessMessage
}

const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", utf8(text))).pipe(
    Effect.map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))
  )

/** Equal-length hex digests, compared without an early exit. */
const sameHash = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export class DesktopAccess extends Context.Service<
  DesktopAccess,
  {
    /** `EmailAccessLink`: a new link for the request, emailed to them; the card says so. */
    readonly email: (
      userId: UserId,
      projectId: ProjectId,
      messageId: MessageId
    ) => Effect.Effect<AccessMessage, NotFound | InvalidRequest | UpstreamFailure>
    /**
     * Uses the link up for this browser, returning the link id and the new session's cookie value. The browser
     * that opened it already (its cookie matches) just gets the link id again.
     */
    readonly open: (
      token: Redacted.Redacted<string>,
      cookies: Readonly<Record<string, string>>
    ) => Effect.Effect<
      { readonly linkId: string; readonly session?: Redacted.Redacted<string> | undefined },
      DesktopLinkUnusable
    >
    /** The link and its request, for the browser holding its session. */
    readonly session: (
      linkId: string,
      cookies: Readonly<Record<string, string>>
    ) => Effect.Effect<DesktopSession, DesktopLinkUnusable>
    readonly submitKey: (
      session: DesktopSession,
      key: Redacted.Redacted<string>
    ) => Effect.Effect<AccessMessage, NotFound | InvalidRequest | UpstreamFailure>
    readonly submitApple: (
      session: DesktopSession,
      apple: { readonly issuerId: string; readonly keyId: string; readonly privateKey: Redacted.Redacted<string> }
    ) => Effect.Effect<AccessMessage, NotFound | InvalidRequest | UpstreamFailure>
    /** Starts a Google or OAuth sign-in in this browser: the provider's authorize URL. */
    readonly signIn: (session: DesktopSession) => Effect.Effect<string, NotFound | InvalidRequest | UpstreamFailure>
    /** A desktop sign-in came back connected: the link is done. */
    readonly signedIn: (linkId: string) => Effect.Effect<void>
  }
>()("@dream/api/DesktopAccess") {
  static readonly layer = Layer.effect(
    DesktopAccess,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const links = yield* DesktopLinks
      const projects = yield* Projects
      const users = yield* Users
      const clients = yield* ProjectClients
      const access = yield* Access
      const mailer = yield* Mailer
      const meter = yield* Meter

      const getAccess = (projectId: ProjectId, messageId: MessageId) =>
        clients.use(projectId, (client) => client.GetAccess({ messageId }))

      const setDesktop = (projectId: ProjectId, messageId: MessageId, desktop: AccessDesktop) =>
        clients.use(projectId, (client) => client.SetAccessDesktop({ messageId, desktop }))

      const email = Effect.fn("DesktopAccess.email")(function* (
        userId: UserId,
        projectId: ProjectId,
        messageId: MessageId
      ) {
        const project = yield* projects.findOwned(userId, projectId)
        if (Option.isNone(project)) return yield* new NotFound({ entity: "project", id: projectId })
        const message = yield* getAccess(projectId, messageId)
        if (!canFinishOnDesktop(message)) {
          return yield* new InvalidRequest({ message: "This doesn't need anything from you anymore." })
        }
        const user = yield* users.find(userId)
        if (Option.isNone(user) || user.value.email.length === 0) {
          return yield* new InvalidRequest({ message: "There's no email address on your account." })
        }
        const now = yield* Clock.currentTimeMillis
        const sent = yield* links.sentSince(userId, projectId, messageId, now - Duration.toMillis(Duration.hours(1)))
        if (sent.forMessage >= SendLimit.perMessage || sent.forUser >= SendLimit.perUser) {
          return yield* new InvalidRequest({
            message: "That's a few emails already. Check your inbox and spam, or try again in an hour."
          })
        }
        const id = `dsk_${randomToken(22)}`
        const token = randomToken(43)
        // Only the newest link works: an older email for the same request stops working.
        yield* links.revokeFor(projectId, messageId, now)
        yield* links.insert({
          id,
          tokenHash: yield* sha256(token),
          userId,
          projectId,
          messageId,
          nowMs: now,
          expiresAtMs: now + Duration.toMillis(LinkLifetime)
        })
        const to = user.value.email
        yield* mailer
          .send(
            accessEmail({
              to,
              heading: accessHeading(message).title,
              project: project.value.title,
              url: `${config.apiUrl}/desktop#${token}`,
              minutes: Duration.toMinutes(LinkLifetime)
            })
          )
          .pipe(Effect.tapError(() => links.revoke(id, now)))
        yield* meter.record([
          {
            id: `email:${id}`,
            owner: userId,
            meter: "email_sent",
            at: DateTime.makeUnsafe(now),
            quantities: { recipients: 1 },
            dimensions: { project: projectId, payer: "dream", provider: "cloudflare-email" }
          }
        ])
        return yield* setDesktop(projectId, messageId, { sentAt: DateTime.makeUnsafe(now), to })
      })

      /** The request still waits for this link: anything else ends it, and the page says what happened. */
      const waiting = (link: DesktopLinkRow, nowMs: number) =>
        Effect.gen(function* () {
          const message = yield* getAccess(link.project_id, link.message_id).pipe(
            Effect.catch(() => Effect.fail(new DesktopLinkUnusable({ reason: "closed" })))
          )
          if (!canFinishOnDesktop(message)) {
            yield* links.revoke(link.id, nowMs)
            return yield* new DesktopLinkUnusable({ reason: "closed", message })
          }
          return message
        })

      /** Why a link can't be opened, or used, whatever its session. */
      const ended = (link: DesktopLinkRow): DesktopLinkUnusable | undefined =>
        link.finished_at_ms !== null
          ? new DesktopLinkUnusable({ reason: "finished" })
          : link.revoked_at_ms !== null
            ? new DesktopLinkUnusable({ reason: "replaced" })
            : undefined

      const byToken = (token: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          const value = Redacted.value(token)
          if (!/^[A-Za-z0-9]{43}$/.test(value)) return yield* new DesktopLinkUnusable({ reason: "invalid" })
          const found = yield* links.byTokenHash(yield* sha256(value))
          if (Option.isNone(found)) return yield* new DesktopLinkUnusable({ reason: "invalid" })
          return found.value
        })

      /** Whether the browser holds the link's session: "no", "expired" (it did), or "yes". */
      const sessionOf = (link: DesktopLinkRow, cookies: Readonly<Record<string, string>>, nowMs: number) =>
        Effect.gen(function* () {
          const cookie = cookies[sessionCookie(link.id)]
          if (cookie === undefined || link.session_hash === null || link.session_expires_at_ms === null) return "no"
          if (!sameHash(yield* sha256(cookie), link.session_hash)) return "no"
          return link.session_expires_at_ms <= nowMs ? "expired" : "yes"
        })

      const open = Effect.fn("DesktopAccess.open")(function* (
        token: Redacted.Redacted<string>,
        cookies: Readonly<Record<string, string>>
      ) {
        const now = yield* Clock.currentTimeMillis
        const link = yield* byToken(token)
        const over = ended(link)
        if (over !== undefined) return yield* over
        if (link.opened_at_ms !== null) {
          // The same browser following the email again goes back to its page; anyone else finds it used.
          if ((yield* sessionOf(link, cookies, now)) === "yes") return { linkId: link.id }
          return yield* new DesktopLinkUnusable({ reason: "used" })
        }
        if (link.expires_at_ms <= now) return yield* new DesktopLinkUnusable({ reason: "expired" })
        const message = yield* waiting(link, now)
        const session = randomToken(43)
        if (!(yield* links.open(link.id, yield* sha256(session), now, now + Duration.toMillis(SessionLifetime)))) {
          return yield* new DesktopLinkUnusable({ reason: "used" })
        }
        // The card shows it was opened, so a link someone else opened doesn't go unnoticed.
        if (message.desktop !== undefined) {
          yield* setDesktop(link.project_id, link.message_id, {
            ...message.desktop,
            openedAt: DateTime.makeUnsafe(now)
          }).pipe(Effect.catch(() => Effect.void))
        }
        return { linkId: link.id, session: Redacted.make(session) }
      })

      const session = Effect.fn("DesktopAccess.session")(function* (
        linkId: string,
        cookies: Readonly<Record<string, string>>
      ) {
        const now = yield* Clock.currentTimeMillis
        if (!/^dsk_[A-Za-z0-9]{22}$/.test(linkId)) return yield* new DesktopLinkUnusable({ reason: "invalid" })
        const found = yield* links.byId(linkId)
        if (Option.isNone(found)) return yield* new DesktopLinkUnusable({ reason: "invalid" })
        const link = found.value
        // Whoever doesn't hold its session learns nothing about the link, not even that it finished.
        const held = yield* sessionOf(link, cookies, now)
        if (held !== "yes")
          return yield* new DesktopLinkUnusable({ reason: held === "expired" ? "expired" : "invalid" })
        const over = ended(link)
        if (over !== undefined) return yield* over
        const message = yield* waiting(link, now)
        return { link, message }
      })

      /** After the request was connected through this link. */
      const done = (link: DesktopLinkRow) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => links.finish(link.id, now))

      const submitKey = Effect.fn("DesktopAccess.submitKey")(function* (
        { link }: DesktopSession,
        key: Redacted.Redacted<string>
      ) {
        const message = yield* access.submitKey(link.user_id, link.project_id, link.message_id, Redacted.value(key))
        yield* done(link)
        return message
      })

      const submitApple = Effect.fn("DesktopAccess.submitApple")(function* (
        { link }: DesktopSession,
        apple: { readonly issuerId: string; readonly keyId: string; readonly privateKey: Redacted.Redacted<string> }
      ) {
        const message = yield* access.submitApple(link.user_id, link.project_id, link.message_id, {
          issuerId: apple.issuerId,
          keyId: apple.keyId,
          privateKey: Redacted.value(apple.privateKey)
        })
        yield* done(link)
        return message
      })

      const signIn = Effect.fn("DesktopAccess.signIn")(function* ({ link, message }: DesktopSession) {
        const options = { statePrefix: desktopStatePrefix(link.id) }
        if (message.request._tag === "Google") {
          return yield* access.startGoogle(link.user_id, link.project_id, link.message_id, options)
        }
        if (message.request._tag === "OAuth") {
          return yield* access.startOAuth(link.user_id, link.project_id, link.message_id, options)
        }
        return yield* new InvalidRequest({ message: "This request doesn't use a sign-in." })
      })

      const signedIn = (linkId: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => links.finish(linkId, now)).pipe(Effect.asVoid)

      return DesktopAccess.of({ email, open, session, submitKey, submitApple, signIn, signedIn })
    })
  )
}
