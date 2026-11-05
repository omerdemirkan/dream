/**
 * Connecting a Claude or ChatGPT subscription, once per person, through each
 * CLI's own sign-in flow in a short-lived "auth" sandbox:
 * - Claude: `claude setup-token` in a PTY. Dream relays the authorize URL;
 *   they paste the code back; the long-lived token it prints is stored.
 * - ChatGPT: `codex login --device-auth`. Dream relays the code; when they've
 *   approved it, `~/.codex/auth.json` holds the tokens.
 * Either way the token is stored encrypted and the sandbox is killed.
 * A Claude token they generated themselves can also be pasted on a one-time
 * page (`CreateConnectLink`); `connectToken` stores it the same way.
 */
import {
  InvalidRequest,
  ModelConnectFlow,
  type ModelConnection,
  type ModelConnectionId,
  type ModelProvider,
  NotFound,
  UpstreamFailure,
  type UserId
} from "@dream/domain"
import { Context, DateTime, Duration, Effect, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect"
import { ApiConfig } from "../Config.ts"
import { Connections, type ModelConnectionRow, toModelConnection } from "../db/Connections.ts"
import { AuthSandboxSession, ChatGptCredential, ClaudeCredential } from "../db/Credentials.ts"
import { Secrets } from "../db/Secrets.ts"
import { E2B, type SandboxAccess } from "../e2b/E2B.ts"
import { Envd, type ProcessOutput } from "../e2b/Envd.ts"
import { ProjectDirectory } from "../project/Client.ts"
import { CodexAuthFile, fromAuthFile } from "./ChatGpt.ts"

const AuthSandboxLifetime = Duration.minutes(20)
const CodexAuthPath = "/home/user/.codex/auth.json"

/** Installs the CLI if the template doesn't have it, then runs the sign-in. */
export const ClaudeSetupCommand =
  "command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; exec claude setup-token"
export const CodexLoginCommand =
  "command -v codex >/dev/null 2>&1 || npm install -g @openai/codex >/dev/null 2>&1; mkdir -p ~/.codex && exec codex login --device-auth"

// biome-ignore lint: control characters are the point
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export const stripAnsi = (text: string): string => text.replace(ansi, "")

/** The authorize URL `claude setup-token` shows: from an OSC 8 hyperlink target if present, else the text. */
export const findClaudeUrl = (output: string): Option.Option<string> => {
  const osc = /\u001b\]8;[^;]*;(https:\/\/[^\u0007\u001b]*oauth\/authorize[^\u0007\u001b]*)/.exec(output)
  if (osc?.[1] !== undefined) return Option.some(osc[1])
  const plain = /(https:\/\/\S*oauth\/authorize\?\S+)/.exec(stripAnsi(output).replace(/\r?\n/g, ""))
  return Option.fromUndefinedOr(plain?.[1])
}

export const findClaudeToken = (output: string): Option.Option<string> => {
  const match = /(sk-ant-oat[A-Za-z0-9_-]{20,})/.exec(stripAnsi(output).replace(/\s+/g, ""))
  return Option.fromUndefinedOr(match?.[1])
}

/** The shape of a long-lived Claude OAuth token (`sk-ant-oat01-…`). */
export const isClaudeToken = (token: string): boolean => /^sk-ant-oat[A-Za-z0-9_-]{20,}$/.test(token)

export const findDeviceCode = (output: string): Option.Option<{ readonly url: string; readonly code: string }> => {
  const text = stripAnsi(output)
  const url = /(https:\/\/auth\.openai\.com\/\S*device\S*)/.exec(text)?.[1]
  const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/.exec(text)?.[1]
  return url === undefined || code === undefined ? Option.none() : Option.some({ url, code })
}

/** Reads `stream` until `find` matches the accumulated text, or `timeout`. */
const readUntil = <A>(
  stream: Stream.Stream<ProcessOutput, UpstreamFailure>,
  find: (text: string) => Option.Option<A>,
  timeout: Duration.Input
) =>
  stream.pipe(
    Stream.mapAccum(
      () => "",
      (text, event) => {
        const next = event._tag === "Output" ? text + event.text : text
        return [next, [{ text: next, ended: event._tag === "End" }]] as const
      }
    ),
    Stream.takeUntil((state) => Option.isSome(find(state.text)) || state.ended),
    Stream.runLast,
    Effect.map((last) => Option.flatMap(last, (state) => find(state.text))),
    Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(Option.none<A>()) })
  )

const invalidCode = new InvalidRequest({
  message: "That code didn't work. Start connecting again to get a fresh link, and paste the whole code it shows."
})

export class ModelConnect extends Context.Service<
  ModelConnect,
  {
    readonly start: (
      userId: UserId,
      provider: ModelProvider
    ) => Effect.Effect<{ readonly connection: ModelConnection; readonly flow: ModelConnectFlow }, UpstreamFailure>
    readonly complete: (
      userId: UserId,
      id: ModelConnectionId,
      code: string
    ) => Effect.Effect<ModelConnection, NotFound | InvalidRequest | UpstreamFailure>
    /** The connection; a pending ChatGPT one is checked for a finished sign-in first. */
    readonly get: (userId: UserId, id: ModelConnectionId) => Effect.Effect<ModelConnection, NotFound>
    /** Stores a Claude token they pasted (already shape-checked) as their connected subscription. */
    readonly connectToken: (userId: UserId, token: Redacted.Redacted<string>) => Effect.Effect<ModelConnection>
    readonly disconnect: (userId: UserId, id: ModelConnectionId) => Effect.Effect<void, NotFound | UpstreamFailure>
    /** Kills auth sandboxes of connections left pending too long. */
    readonly cleanup: Effect.Effect<void>
  }
>()("@dream/api/ModelConnect") {
  static readonly layer = Layer.effect(
    ModelConnect,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const connections = yield* Connections
      const secrets = yield* Secrets
      const e2b = yield* E2B
      const envd = yield* Envd
      const directory = yield* ProjectDirectory

      const template = Option.getOrElse(config.authTemplate, () => config.sandboxTemplate)

      const accessFor = (session: AuthSandboxSession): SandboxAccess => ({
        sandboxId: session.sandboxId,
        domain: session.domain,
        envdAccessToken: session.envdAccessToken,
        trafficAccessToken: ""
      })

      // Rows reference secrets, so rows are updated or deleted before their secrets.
      const endSandbox = (row: ModelConnectionRow) =>
        Effect.gen(function* () {
          if (row.auth_sandbox_id !== null) yield* e2b.kill(row.auth_sandbox_id).pipe(Effect.ignore)
          yield* connections.updateModelConnection(row.id, { authSandboxId: null, authSecretId: null })
          if (row.auth_secret_id !== null) yield* secrets.remove(row.auth_secret_id)
        })

      const fail = (row: ModelConnectionRow, error: string) =>
        Effect.gen(function* () {
          yield* endSandbox(row)
          yield* connections.updateModelConnection(row.id, { status: "failed", error, flow: null })
        })

      /** Replaces any earlier connection for the same provider, once the new one works. */
      const connected = (row: ModelConnectionRow, secretId: string, accessExpiresAtMs?: number) =>
        Effect.gen(function* () {
          yield* endSandbox(row)
          yield* connections.updateModelConnection(row.id, {
            status: "connected",
            secretId,
            flow: null,
            error: null,
            connectedAt: yield* DateTime.now,
            ...(accessExpiresAtMs === undefined ? {} : { accessExpiresAtMs })
          })
          for (const other of yield* connections.modelConnections(row.user_id)) {
            if (other.id === row.id || other.provider !== row.provider) continue
            yield* endSandbox(other)
            yield* connections.deleteModelConnection(other.id)
            if (other.secret_id !== null) yield* secrets.remove(other.secret_id)
          }
          yield* directory.credentialsChanged(row.user_id)
          return toModelConnection((yield* connections.modelConnection(row.user_id, row.id)).pipe(Option.getOrThrow))
        })

      const start = Effect.fn("ModelConnect.start")(function* (userId: UserId, provider: ModelProvider) {
        // One sign-in at a time per provider.
        for (const other of yield* connections.modelConnections(userId)) {
          if (other.provider === provider && other.status === "pending") {
            yield* endSandbox(other)
            yield* connections.deleteModelConnection(other.id)
          }
        }
        const row = yield* connections.createModelConnection(userId, provider)
        const run = Effect.gen(function* () {
          const sandbox = yield* e2b.create({
            template,
            timeoutSeconds: Duration.toSeconds(AuthSandboxLifetime),
            autoPause: false,
            envVars: {},
            metadata: { purpose: "model-connect", connectionId: row.id, userId },
            rules: {}
          })
          const output =
            provider === "claude"
              ? envd.start(sandbox, { command: ClaudeSetupCommand, pty: { cols: 500, rows: 40 } })
              : envd.start(sandbox, { command: CodexLoginCommand })
          let pid = -1
          const withPid = output.pipe(
            Stream.tap((event) => Effect.sync(() => void (event._tag === "Start" && (pid = event.pid))))
          )
          const flow: ModelConnectFlow =
            provider === "claude"
              ? yield* readUntil(withPid, findClaudeUrl, "150 seconds").pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.fail(
                          new UpstreamFailure({
                            service: "Claude",
                            message: "claude setup-token didn't show a sign-in link"
                          })
                        ),
                      onSome: (authorizeUrl) => Effect.succeed(ModelConnectFlow.cases.PasteCode.make({ authorizeUrl }))
                    })
                  )
                )
              : yield* readUntil(withPid, findDeviceCode, "150 seconds").pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.fail(
                          new UpstreamFailure({ service: "ChatGPT", message: "codex login didn't show a device code" })
                        ),
                      onSome: ({ url, code }) =>
                        Effect.map(DateTime.now, (now) =>
                          ModelConnectFlow.cases.DeviceCode.make({
                            verificationUrl: url,
                            userCode: code,
                            expiresAt: DateTime.add(now, { minutes: 15 })
                          })
                        )
                    })
                  )
                )
          const sessionId = yield* secrets.put(userId, "auth_session", AuthSandboxSession, {
            sandboxId: sandbox.sandboxId,
            domain: sandbox.domain,
            envdAccessToken: sandbox.envdAccessToken,
            pid
          })
          yield* connections.updateModelConnection(row.id, {
            authSandboxId: sandbox.sandboxId,
            authSecretId: sessionId,
            flow
          })
          return flow
        })
        const flow = yield* run.pipe(Effect.tapError((error) => fail(row, error.message)))
        const latest = (yield* connections.modelConnection(userId, row.id)).pipe(Option.getOrThrow)
        return { connection: toModelConnection(latest), flow }
      })

      const pendingRow = (userId: UserId, id: ModelConnectionId) =>
        Effect.flatMap(connections.modelConnection(userId, id), (found) =>
          Option.match(found, {
            onNone: () => Effect.fail(new NotFound({ entity: "model connection", id })),
            onSome: Effect.succeed
          })
        )

      const complete = Effect.fn("ModelConnect.complete")(function* (
        userId: UserId,
        id: ModelConnectionId,
        code: string
      ) {
        const row = yield* pendingRow(userId, id)
        if (row.status === "connected") return toModelConnection(row)
        if (row.provider !== "claude" || row.status !== "pending" || row.auth_secret_id === null) {
          return yield* new InvalidRequest({
            message: "This connection isn't waiting for a code. Start connecting again."
          })
        }
        const session = yield* secrets.get(row.auth_secret_id, AuthSandboxSession)
        const sandbox = accessFor(session)
        type Outcome = { readonly _tag: "Token"; readonly token: string } | { readonly _tag: "Invalid" }
        const reader = yield* readUntil(
          envd.attach(sandbox, session.pid),
          (text): Option.Option<Outcome> => {
            const token = findClaudeToken(text)
            if (Option.isSome(token)) return Option.some({ _tag: "Token" as const, token: token.value })
            return /OAuth error|Invalid code|Press Enter to retry/i.test(stripAnsi(text))
              ? Option.some({ _tag: "Invalid" as const })
              : Option.none()
          },
          "90 seconds"
        ).pipe(Effect.forkChild)
        // Let the attach stream open before typing into the PTY.
        yield* Effect.sleep("500 millis")
        yield* envd.sendInput(sandbox, session.pid, `${code.trim()}\r`, true)
        const result = yield* Fiber.join(reader)
        if (Option.isNone(result)) {
          yield* fail(row, "Claude didn't confirm the code")
          return yield* new UpstreamFailure({
            service: "Claude",
            message: "the sign-in didn't finish. Start connecting again."
          })
        }
        if (result.value._tag === "Invalid") {
          yield* fail(row, "invalid code")
          return yield* invalidCode
        }
        const secretId = yield* secrets.put(userId, "claude_token", ClaudeCredential, { token: result.value.token })
        return yield* connected(row, secretId)
      })

      const get = Effect.fn("ModelConnect.get")(function* (userId: UserId, id: ModelConnectionId) {
        const row = yield* pendingRow(userId, id)
        if (row.status !== "pending" || row.provider !== "chatgpt" || row.auth_secret_id === null)
          return toModelConnection(row)
        const check = Effect.gen(function* () {
          const session = yield* secrets.get(row.auth_secret_id!, AuthSandboxSession)
          const file = yield* envd.readFile(accessFor(session), CodexAuthPath)
          if (Option.isNone(file)) {
            const expired =
              row.flow_json?._tag === "DeviceCode" &&
              DateTime.toEpochMillis(row.flow_json.expiresAt) < DateTime.toEpochMillis(yield* DateTime.now)
            if (expired) yield* fail(row, "the code expired")
            return toModelConnection((yield* connections.modelConnection(userId, id)).pipe(Option.getOrThrow))
          }
          const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CodexAuthFile))(file.value).pipe(
            Effect.mapError(
              () => new UpstreamFailure({ service: "ChatGPT", message: "Codex wrote an auth file Dream can't read" })
            )
          )
          const credential = yield* fromAuthFile(parsed)
          const secretId = yield* secrets.put(userId, "chatgpt_tokens", ChatGptCredential, credential)
          return yield* connected(row, secretId, credential.accessExpiresAtMs)
        })
        return yield* check.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("checking the ChatGPT sign-in failed", error.message)
              return toModelConnection(row)
            })
          )
        )
      })

      const connectToken = Effect.fn("ModelConnect.connectToken")(function* (
        userId: UserId,
        token: Redacted.Redacted<string>
      ) {
        const row = yield* connections.createModelConnection(userId, "claude")
        const secretId = yield* secrets.put(userId, "claude_token", ClaudeCredential, { token: Redacted.value(token) })
        return yield* connected(row, secretId)
      })

      const disconnect = Effect.fn("ModelConnect.disconnect")(function* (userId: UserId, id: ModelConnectionId) {
        const row = yield* pendingRow(userId, id)
        yield* endSandbox(row)
        yield* connections.deleteModelConnection(row.id)
        if (row.secret_id !== null) yield* secrets.remove(row.secret_id)
        yield* directory.credentialsChanged(userId)
      })

      const cleanup = Effect.gen(function* () {
        const before = DateTime.subtract(yield* DateTime.now, { minutes: Duration.toMinutes(AuthSandboxLifetime) })
        for (const row of yield* connections.stalePending(before))
          yield* fail(row, "the sign-in wasn't finished in time")
      })

      return ModelConnect.of({ start, complete, get, connectToken, disconnect, cleanup })
    })
  )
}
