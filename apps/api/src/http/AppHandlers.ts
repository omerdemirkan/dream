/**
 * `AppRpcs` (phone → Worker at `Routes.app`): sign-in, devices, Home, and
 * everything about a project that isn't the live stream. Project-scoped calls
 * check ownership in D1, then go to that project's DO.
 */
import {
  AppAuth,
  AttachmentLimits,
  AuthedAppRpcs,
  CurrentUser,
  type Harness,
  InvalidRequest,
  NoModelConnection,
  NotFound,
  NotInvited,
  type Project,
  type ProjectId,
  PublicAppRpcs,
  Routes,
  Unauthorized,
  UpstreamFailure,
  type UserId,
  safeAttachmentName
} from "@dream/domain"
import { DateTime, Effect, Layer, Option, Redacted } from "effect"
import { Headers } from "effect/http"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { ConnectLinks } from "../connect/ConnectLinks.ts"
import { ModelConnect } from "../connect/ModelConnect.ts"
import { Attachments } from "../db/Attachments.ts"
import { Connections, toModelConnection } from "../db/Connections.ts"
import { Projects, titleFromIdea } from "../db/Projects.ts"
import { Users } from "../db/Users.ts"
import { Access } from "../integrations/Access.ts"
import { DesktopAccess } from "../desktop/DesktopAccess.ts"
import { Mailer } from "../email/Mailer.ts"
import { AppLinks, NoHandAddedLinks } from "../links/AppLinks.ts"
import { Links } from "../db/Links.ts"
import { Google } from "../integrations/Google.ts"
import { timingSafeEqual } from "../lib/Bytes.ts"
import { messageIdFor, newMediaId, newMessageId, newProjectId, projectIdFor } from "../lib/Ids.ts"
import { ProjectClients } from "../project/Client.ts"
import { deleteProject } from "../project/Deletion.ts"
import { UsageReport } from "../usage/ProjectUsage.ts"
import { MediaStore } from "./Media.ts"

export const bearer = (headers: Headers.Headers): Option.Option<string> =>
  Option.flatMap(Headers.get(headers, "authorization"), (value) => {
    const match = /^Bearer\s+(.+)$/i.exec(value)
    return Option.fromUndefinedOr(match?.[1]?.trim())
  })

export const AppAuthServer = Layer.effect(
  AppAuth,
  Effect.gen(function* () {
    const tokens = yield* Tokens
    return AppAuth.of((effect, { headers }) =>
      Option.match(bearer(headers), {
        onNone: () => Effect.fail(new Unauthorized({ message: "Sign in first." })),
        onSome: (token) =>
          tokens.verifySession(token).pipe(
            Effect.mapError(() => new Unauthorized({ message: "Your session expired. Sign in again." })),
            Effect.flatMap((session) => Effect.provideService(effect, CurrentUser, session))
          )
      })
    )
  })
)

export const PublicHandlers = PublicAppRpcs.toLayer(
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const users = yield* Users
    const tokens = yield* Tokens
    const google = yield* Google

    const signedIn = (user: { readonly id: UserId; readonly email: string }) =>
      Effect.map(tokens.session(user), (sessionToken) => sessionToken)

    return {
      SignIn: ({ googleIdToken }) =>
        Effect.gen(function* () {
          const identity = yield* google.verifyIdToken(googleIdToken).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "Google sign-in refused",
                error._tag === "InvalidIdToken" ? error.reason : error.message
              )
            ),
            Effect.catchTags({
              InvalidIdToken: (error) =>
                Effect.fail(new Unauthorized({ message: `Google sign-in failed (${error.reason}).` })),
              UpstreamFailure: (error) => Effect.fail(new Unauthorized({ message: error.message }))
            })
          )
          if (!(yield* users.isInvited(identity.email))) {
            yield* Effect.logWarning("Google sign-in from an account that isn't invited", identity.email)
            return yield* new NotInvited({ email: identity.email })
          }
          const user = yield* users.upsertGoogle({ sub: identity.sub, email: identity.email, name: identity.name })
          return { sessionToken: yield* signedIn(user), user }
        }),
      DevSignIn: ({ email, name, secret }) =>
        Effect.gen(function* () {
          const expected = config.devLoginSecret
          if (Option.isNone(expected) || !timingSafeEqual(Redacted.value(expected.value), Redacted.value(secret))) {
            return yield* new Unauthorized({ message: "Dev sign-in isn't available." })
          }
          const user = yield* users.upsertByEmail(email, name)
          return { sessionToken: yield* signedIn(user), user }
        })
    }
  })
)

export const AuthedHandlers = AuthedAppRpcs.toLayer(
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const users = yield* Users
    const tokens = yield* Tokens
    const projects = yield* Projects
    const connections = yield* Connections
    const clients = yield* ProjectClients
    const access = yield* Access
    const desktopAccess = yield* DesktopAccess
    const mailer = yield* Mailer
    const modelConnect = yield* ModelConnect
    const connectLinks = yield* ConnectLinks
    const mediaStore = yield* MediaStore
    const appLinks = yield* AppLinks
    const links = yield* Links
    const usageReport = yield* UsageReport
    const attachments = yield* Attachments

    const me = Effect.gen(function* () {
      return (yield* CurrentUser).userId
    })

    const owned = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const userId = yield* me
        const project = yield* projects.findOwned(userId, projectId)
        if (Option.isNone(project)) return yield* new NotFound({ entity: "project", id: projectId })
        return project.value
      })

    const harnessFor = (userId: UserId, requested: Harness | undefined) =>
      Effect.gen(function* () {
        const claude = yield* connections.connectedModel(userId, "claude")
        const chatgpt = yield* connections.connectedModel(userId, "chatgpt")
        if (requested === "claude-code") {
          if (Option.isNone(claude))
            return yield* new NoModelConnection({ message: "Connect your Claude subscription first." })
          return requested
        }
        if (requested === "codex") {
          if (Option.isNone(chatgpt))
            return yield* new NoModelConnection({ message: "Connect your ChatGPT subscription first." })
          return requested
        }
        // Their connected subscription; the more recently connected one if they have both.
        const options = [
          ...Option.toArray(Option.map(claude, (row) => ({ harness: "claude-code" as const, at: row.connected_at }))),
          ...Option.toArray(Option.map(chatgpt, (row) => ({ harness: "codex" as const, at: row.connected_at })))
        ].sort(
          (a, b) =>
            (b.at === null ? 0 : DateTime.toEpochMillis(b.at)) - (a.at === null ? 0 : DateTime.toEpochMillis(a.at))
        )
        const first = options[0]
        if (first === undefined) {
          return yield* new NoModelConnection({ message: "Connect your Claude or ChatGPT subscription first." })
        }
        return first.harness
      })

    return {
      GetFeatures: () => Effect.succeed({ emailLinks: mailer.enabled }),
      GetMe: () =>
        Effect.gen(function* () {
          const user = yield* users.find(yield* me)
          return yield* Option.match(user, {
            onNone: () => Effect.die("signed-in user is missing"),
            onSome: Effect.succeed
          })
        }),

      RegisterDevice: (payload) => Effect.flatMap(me, (userId) => users.registerDevice(userId, payload)),
      UnregisterDevice: ({ deviceId }) => Effect.flatMap(me, (userId) => users.unregisterDevice(userId, deviceId)),
      RegisterLiveActivity: ({ projectId, deviceId, activityId, pushToken }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          yield* clients.use(projectId, (client) => client.RegisterLiveActivity({ deviceId, activityId, pushToken }))
        }),
      FilterStaleNotifications: ({ notificationIds }) =>
        Effect.map(
          Effect.flatMap(me, (userId) => projects.staleNotifications(userId, notificationIds)),
          (stale) => ({ stale })
        ),

      ListProjects: () => Effect.flatMap(me, projects.summaries),
      ListOpenAsks: () => Effect.flatMap(me, projects.openAsks),
      ListArchivedProjects: () => Effect.flatMap(me, projects.archived),

      ArchiveProject: ({ projectId }) =>
        Effect.gen(function* () {
          const project = yield* owned(projectId)
          const archivedAt = yield* clients.use(projectId, (client) => client.Archive())
          return { project, archivedAt }
        }),

      DeleteProject: ({ projectId }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          yield* deleteProject(projectId).pipe(
            Effect.provideService(ProjectClients, clients),
            Effect.provideService(Projects, projects),
            Effect.provideService(MediaStore, mediaStore),
            Effect.provideService(Links, links),
            Effect.provideService(Attachments, attachments)
          )
        }),

      RestoreProject: ({ projectId }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          yield* clients.use(projectId, (client) => client.Restore())
          const summary = yield* projects.summary(projectId)
          if (Option.isNone(summary)) return yield* new NotFound({ entity: "project", id: projectId })
          return summary.value
        }),

      CreateProject: ({ idea, harness, requestId, attachments: attachmentIds = [] }) =>
        Effect.gen(function* () {
          const userId = yield* me
          const start = (project: Project) =>
            Effect.gen(function* () {
              // A retry takes the same attachments again, so a half-started project still starts with them.
              const attached = yield* attachments.claim(userId, project.id, project.id, attachmentIds)
              return yield* clients.use(project.id, (client) =>
                client.Init({ project, ...(attached.length === 0 ? {} : { attachments: attached }) })
              )
            }).pipe(
              Effect.catchDefect((defect) =>
                Effect.fail(
                  new UpstreamFailure({ service: "Dream", message: `the project couldn't start: ${String(defect)}` })
                )
              )
            )
          const id = requestId === undefined ? yield* newProjectId() : projectIdFor(requestId)
          if (requestId !== undefined) {
            // A retry: hand back what the first attempt created (Init is idempotent, so a half-started one starts now).
            const existing = yield* projects.find(id)
            if (Option.isSome(existing)) {
              if (existing.value.ownerId !== userId) {
                return yield* new InvalidRequest({ message: "That request id is already taken. Try again." })
              }
              return yield* start(existing.value)
            }
          }
          const chosen = yield* harnessFor(userId, harness)
          // Refuse attachments that aren't theirs before the project exists.
          yield* attachments.claim(userId, id, id, attachmentIds)
          const { slug, host } = yield* projects.allocateHost(idea, config.domain)
          const now = yield* DateTime.now
          const project: Project = {
            id,
            ownerId: userId,
            title: titleFromIdea(idea),
            idea,
            harness: chosen,
            phase: "new",
            slug,
            publicUrl: `https://${host}`,
            createdAt: now,
            updatedAt: now
          }
          yield* projects.insert(project, host)
          return yield* start(project)
        }),

      ListLinks: () => Effect.flatMap(me, appLinks.list),
      ListRemovedLinks: () => Effect.flatMap(me, appLinks.listRemoved),
      RestoreLink: ({ linkId }) => Effect.flatMap(me, (userId) => appLinks.restore(userId, linkId)),
      AddLink: () => Effect.fail(NoHandAddedLinks),
      UpdateLink: ({ linkId, ...changes }) => Effect.flatMap(me, (userId) => appLinks.update(userId, linkId, changes)),
      RemoveLink: ({ linkId }) => Effect.flatMap(me, (userId) => appLinks.remove(userId, linkId)),
      MarkLinkOpened: ({ linkId }) => Effect.flatMap(me, (userId) => appLinks.markOpened(userId, linkId)),
      PrepareHomeScreen: ({ linkId, iconPng }) =>
        Effect.flatMap(me, (userId) => appLinks.prepareHomeScreen(userId, linkId, iconPng)),

      GetLiveUrl: ({ projectId }) =>
        Effect.gen(function* () {
          const project = yield* owned(projectId)
          const ticket = yield* tokens.liveTicket(project.id, project.ownerId)
          return {
            url: `wss://${config.apiHost}${Routes.projectLive(project.id)}?ticket=${encodeURIComponent(ticket)}`
          }
        }),

      GetProjectUsage: ({ projectId }) => Effect.flatMap(owned(projectId), usageReport.projectUsage),
      SetUsageLimits: ({ projectId, limits }) =>
        Effect.gen(function* () {
          const project = yield* owned(projectId)
          yield* clients.use(projectId, (client) => client.SetUsageLimits({ limits }))
          return yield* usageReport.projectUsage(project)
        }),
      GetAccountUsage: ({ provider }) => Effect.flatMap(me, (userId) => usageReport.accountUsage(userId, provider)),

      ListMessages: ({ projectId, before, limit }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) =>
            client.ListMessages({ ...(before === undefined ? {} : { before }), limit: limit ?? 50 })
          )
        }),

      ListThread: ({ projectId, messageId }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) => client.ListThread({ messageId }))
        }),

      SendMessage: ({ projectId, text, requestId, workstream, replyTo, attachments: attachmentIds = [] }) =>
        Effect.gen(function* () {
          const userId = yield* me
          yield* owned(projectId)
          if (text.trim().length === 0 && attachmentIds.length === 0) {
            return yield* new InvalidRequest({ message: "Write something or attach a file first." })
          }
          const id = requestId === undefined ? yield* newMessageId() : messageIdFor(requestId)
          const attached = yield* attachments.claim(userId, projectId, id, attachmentIds)
          return yield* clients.use(projectId, (client) =>
            client.SendUserMessage({
              text,
              id,
              ...(workstream === undefined ? {} : { workstream }),
              ...(replyTo === undefined ? {} : { replyTo }),
              ...(attached.length === 0 ? {} : { attachments: attached })
            })
          )
        }),

      CreateAttachmentUpload: ({ name, contentType, sizeBytes, width, height }) =>
        Effect.gen(function* () {
          const userId = yield* me
          if (Option.isNone(mediaStore.bucket)) {
            return yield* new InvalidRequest({ message: "Attachments aren't switched on yet." })
          }
          if (sizeBytes > AttachmentLimits.maxBytes) {
            return yield* new InvalidRequest({
              message: `That file is over ${AttachmentLimits.maxBytes / 1024 / 1024} MB, the most Dream can take.`
            })
          }
          const id = yield* newMediaId()
          const attachment = {
            id,
            name: safeAttachmentName(name),
            contentType: contentType.toLowerCase(),
            sizeBytes,
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height })
          }
          yield* attachments.insert({ attachment, userId, objectKey: `users/${userId}/attachments/${id}` })
          const upload = yield* tokens.attachmentUpload({
            sub: userId,
            aid: id,
            ct: attachment.contentType,
            size: sizeBytes
          })
          return {
            attachment,
            upload: {
              url: `${config.apiUrl}${Routes.attachmentUpload(id)}?token=${encodeURIComponent(upload.token)}`,
              method: "PUT" as const,
              headers: { "content-type": attachment.contentType },
              expiresAt: DateTime.makeUnsafe(upload.expiresAtMs)
            }
          }
        }),

      AnswerQuestion: ({ projectId, messageId, answer }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) => client.AnswerQuestion({ messageId, answer }))
        }),

      StartGoogleAccess: ({ projectId, messageId }) =>
        Effect.gen(function* () {
          const authorizeUrl = yield* access
            .startGoogle(yield* me, projectId, messageId)
            .pipe(
              Effect.catchTag("UpstreamFailure", (error) =>
                Effect.fail(new NotFound({ entity: "Google sign-in", id: error.message }))
              )
            )
          return { authorizeUrl }
        }),
      StartOAuthAccess: ({ projectId, messageId }) =>
        Effect.gen(function* () {
          const authorizeUrl = yield* access.startOAuth(yield* me, projectId, messageId)
          return { authorizeUrl }
        }),
      SubmitKeyAccess: ({ projectId, messageId, key }) =>
        Effect.flatMap(me, (userId) => access.submitKey(userId, projectId, messageId, Redacted.value(key))),
      SubmitAppleAccess: ({ projectId, messageId, issuerId, keyId, privateKey }) =>
        Effect.flatMap(me, (userId) =>
          access.submitApple(userId, projectId, messageId, { issuerId, keyId, privateKey: Redacted.value(privateKey) })
        ),
      EmailAccessLink: ({ projectId, messageId }) =>
        Effect.flatMap(me, (userId) => desktopAccess.email(userId, projectId, messageId)),
      DeclineAccess: ({ projectId, messageId, reason }) =>
        Effect.flatMap(me, (userId) => access.decline(userId, projectId, messageId, reason?.trim() || undefined)),

      GetAppNotifications: ({ projectId }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) => client.GetAppNotifications())
        }),
      AllowAppNotifications: ({ projectId, messageId }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) => client.AllowAppNotifications({ messageId }))
        }),
      UpdateAppNotifications: ({ projectId, app, delivery, mutedUntil }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) =>
            client.UpdateAppNotifications({
              app,
              ...(delivery === undefined ? {} : { delivery }),
              ...(mutedUntil === undefined ? {} : { mutedUntil })
            })
          )
        }),
      OpenedAppNotification: ({ projectId, notificationId }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) => client.OpenedAppNotification({ notificationId }))
        }),

      ListIntegrations: () => Effect.flatMap(me, access.list),
      ReplaceKey: ({ integrationId, key }) =>
        Effect.flatMap(me, (userId) => access.replaceKey(userId, integrationId, Redacted.value(key))),
      DisconnectIntegration: ({ integrationId }) =>
        Effect.flatMap(me, (userId) => access.disconnect(userId, integrationId)),

      ListModelConnections: () =>
        Effect.map(Effect.flatMap(me, connections.modelConnections), (rows) => rows.map(toModelConnection)),
      StartModelConnection: ({ provider }) => Effect.flatMap(me, (userId) => modelConnect.start(userId, provider)),
      CompleteModelConnection: ({ connectionId, code }) =>
        Effect.flatMap(me, (userId) => modelConnect.complete(userId, connectionId, Redacted.value(code))),
      GetModelConnection: ({ connectionId }) => Effect.flatMap(me, (userId) => modelConnect.get(userId, connectionId)),
      DisconnectModelConnection: ({ connectionId }) =>
        Effect.flatMap(me, (userId) => modelConnect.disconnect(userId, connectionId)),
      CreateConnectLink: ({ provider }) => Effect.flatMap(me, (userId) => connectLinks.create(userId, provider))
    }
  })
)
