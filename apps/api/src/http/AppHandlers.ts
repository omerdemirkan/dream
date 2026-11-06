/**
 * `AppRpcs` (phone → Worker at `Routes.app`): sign-in, devices, Home, and
 * everything about a project that isn't the live stream. Project-scoped calls
 * check ownership in D1, then go to that project's DO.
 */
import {
  AppAuth,
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
  type UserId
} from "@dream/domain"
import { DateTime, Effect, Layer, Option, Redacted } from "effect"
import { Headers } from "effect/http"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { ConnectLinks } from "../connect/ConnectLinks.ts"
import { ModelConnect } from "../connect/ModelConnect.ts"
import { Connections, toModelConnection } from "../db/Connections.ts"
import { Projects, titleFromIdea } from "../db/Projects.ts"
import { Users } from "../db/Users.ts"
import { Access } from "../integrations/Access.ts"
import { Google } from "../integrations/Google.ts"
import { timingSafeEqual } from "../lib/Bytes.ts"
import { messageIdFor, newProjectId, projectIdFor } from "../lib/Ids.ts"
import { ProjectClients } from "../project/Client.ts"
import { deleteProject } from "../project/Deletion.ts"
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
    const modelConnect = yield* ModelConnect
    const connectLinks = yield* ConnectLinks
    const mediaStore = yield* MediaStore

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
            Effect.provideService(MediaStore, mediaStore)
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

      CreateProject: ({ idea, harness, requestId }) =>
        Effect.gen(function* () {
          const userId = yield* me
          const start = (project: Project) =>
            clients
              .use(project.id, (client) => client.Init({ project }))
              .pipe(
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

      GetLiveUrl: ({ projectId }) =>
        Effect.gen(function* () {
          const project = yield* owned(projectId)
          const ticket = yield* tokens.liveTicket(project.id, project.ownerId)
          return {
            url: `wss://${config.apiHost}${Routes.projectLive(project.id)}?ticket=${encodeURIComponent(ticket)}`
          }
        }),

      ListMessages: ({ projectId, before, limit }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) =>
            client.ListMessages({ ...(before === undefined ? {} : { before }), limit: limit ?? 50 })
          )
        }),

      SendMessage: ({ projectId, text, requestId }) =>
        Effect.gen(function* () {
          yield* owned(projectId)
          return yield* clients.use(projectId, (client) =>
            client.SendUserMessage({ text, ...(requestId === undefined ? {} : { id: messageIdFor(requestId) }) })
          )
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
      DeclineAccess: ({ projectId, messageId }) =>
        Effect.flatMap(me, (userId) => access.decline(userId, projectId, messageId)),

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
