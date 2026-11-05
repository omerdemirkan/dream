/**
 * dreamd's two doors.
 *
 * - The daemon port serves `DaemonRpcs` to the ProjectDO. E2B only forwards
 *   requests that carry the sandbox's traffic token, but anything inside the
 *   sandbox can reach the port on localhost, so every call also needs the
 *   daemon token.
 * - The Unix socket is for the `dream` CLI, from any process in the sandbox.
 *   It forwards `SandboxRpcs` requests to the API unchanged, adding the
 *   project token, so the CLI never holds a credential and the API decides
 *   everything. The calls only dreamd makes (`ReportTurn`, `ReportUsage`) are
 *   refused there, so an app can't fake the agent's state.
 */
import { timingSafeEqual } from "node:crypto"
import { chmod, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { DaemonAuth, DaemonRpcs, HttpRpcSerialization, Routes, Unauthorized } from "@dream/domain"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/http"
import { RpcServer } from "effect/rpc"
import { Agent } from "./Agent.ts"
import { DreamdConfig } from "./Config.ts"
import { Inbox } from "./Inbox.ts"
import { version } from "./version.ts"

// ---------------------------------------------------------------------------
// DaemonRpcs on the port
// ---------------------------------------------------------------------------

const DaemonHandlers = DaemonRpcs.toLayer(
  Effect.gen(function* () {
    const inbox = yield* Inbox
    const agent = yield* Agent
    return {
      Deliver: ({ events, timeZone }) =>
        inbox.deliver(events, timeZone).pipe(
          Effect.map((accepted) => ({ accepted })),
          Effect.tap(({ accepted }) => Effect.logInfo("Delivered", { events: accepted })),
          Effect.orDie
        ),
      Health: () => agent.status.pipe(Effect.map((status) => ({ version, ...status })))
    }
  })
)

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const DaemonAuthLive = Layer.effect(
  DaemonAuth,
  Effect.gen(function* () {
    const config = yield* DreamdConfig
    const expected = `Bearer ${Redacted.value(config.daemonToken)}`
    return DaemonAuth.of((effect, { headers }) =>
      Option.match(Headers.get(headers, "authorization"), {
        onNone: () => Effect.fail(new Unauthorized({ message: "Missing daemon token" })),
        onSome: (given) =>
          sameSecret(given, expected) ? effect : Effect.fail(new Unauthorized({ message: "Wrong daemon token" }))
      })
    )
  })
)

export const DaemonServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DreamdConfig
    return HttpRouter.serve(
      RpcServer.layerHttp({ group: DaemonRpcs, path: Routes.daemon, protocol: "http" }).pipe(
        Layer.provide([DaemonHandlers, DaemonAuthLive, HttpRpcSerialization])
      ),
      { disableListenLog: true, disableLogger: true }
    ).pipe(Layer.provide(NodeHttpServer.layer(() => createServer(), { port: config.port, host: "0.0.0.0" })))
  })
)

// ---------------------------------------------------------------------------
// The CLI socket
// ---------------------------------------------------------------------------

/** Calls only dreamd makes. */
export const dreamdOnly: ReadonlySet<string> = new Set(["ReportTurn", "ReportUsage"])

const RequestLine = Schema.fromJsonString(Schema.Struct({ _tag: Schema.Literal("Request"), tag: Schema.String }))
const decodeRequestLine = Schema.decodeUnknownOption(RequestLine)

/** The RPCs named in an NDJSON request body. */
export const requestedTags = (body: string): ReadonlyArray<string> =>
  body
    .split("\n")
    .flatMap((line) => Option.match(decodeRequestLine(line), { onNone: () => [], onSome: ({ tag }) => [tag] }))

const proxy = HttpRouter.add(
  "POST",
  Routes.sandbox,
  Effect.gen(function* () {
    const config = yield* DreamdConfig
    const client = yield* HttpClient.HttpClient
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* request.text
    const refused = requestedTags(body).filter((tag) => dreamdOnly.has(tag))
    if (refused.length > 0) {
      return HttpServerResponse.text(`${refused.join(", ")} can only be called by dreamd.`, { status: 403 })
    }
    const contentType = request.headers["content-type"] ?? "application/ndjson"
    return yield* client
      .post(`${config.apiUrl}${Routes.sandbox}`, {
        body: HttpBody.text(body, contentType),
        headers: { authorization: `Bearer ${Redacted.value(config.projectToken)}` }
      })
      .pipe(
        Effect.map((response) =>
          HttpServerResponse.stream(response.stream, {
            status: response.status,
            contentType: response.headers["content-type"] ?? contentType
          })
        ),
        Effect.catch((error) =>
          Effect.logWarning("Couldn't reach the API", { error: error.message }).pipe(
            Effect.as(HttpServerResponse.text(`Couldn't reach Dream: ${error.message}`, { status: 502 }))
          )
        )
      )
  })
)

const health = HttpRouter.add("GET", "/health", Effect.succeed(HttpServerResponse.text("ok")))

export const SocketServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DreamdConfig
    yield* Effect.promise(() => rm(config.socket, { force: true }))
    const server = createServer()
    // Any process in the sandbox may use the CLI, whichever user it runs as.
    server.once("listening", () => void chmod(config.socket, 0o666).catch(() => {}))
    return HttpRouter.serve(Layer.mergeAll(proxy, health), { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provide(NodeHttpServer.layer(() => server, { path: config.socket })),
      Layer.provide(FetchHttpClient.layer)
    )
  })
)
