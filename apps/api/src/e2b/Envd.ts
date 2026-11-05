/**
 * envd, the agent inside every E2B sandbox (port 49983): start processes
 * (optionally in a PTY), reattach to their output, send input, and read and
 * write files. Spoken directly: Connect RPC with JSON for `process.Process`,
 * plain HTTP for `/files`.
 *
 * Processes keep running when the stream that started them is dropped
 * (verified), so a Worker request can start one and a later request can
 * reattach with `Connect` or type into it with `SendInput`.
 */
import { UpstreamFailure } from "@dream/domain"
import { Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { fromBase64, fromUtf8, toBase64, utf8 } from "../lib/Bytes.ts"
import { describe, okOrFail, type SandboxAccess } from "./E2B.ts"

export const EnvdPort = 49983
export const DefaultUser = "user"

const ProcessEvent = Schema.Struct({
  start: Schema.optionalKey(Schema.Struct({ pid: Schema.Number })),
  data: Schema.optionalKey(
    Schema.Struct({
      stdout: Schema.optionalKey(Schema.String),
      stderr: Schema.optionalKey(Schema.String),
      pty: Schema.optionalKey(Schema.String)
    })
  ),
  end: Schema.optionalKey(
    Schema.Struct({
      exitCode: Schema.optionalKey(Schema.Number),
      exited: Schema.optionalKey(Schema.Boolean),
      status: Schema.optionalKey(Schema.String),
      error: Schema.optionalKey(Schema.String)
    })
  ),
  keepalive: Schema.optionalKey(Schema.Unknown)
})

const StreamMessage = Schema.Struct({ event: ProcessEvent })

/** What a process said or did, decoded. */
export type ProcessOutput =
  | { readonly _tag: "Start"; readonly pid: number }
  | { readonly _tag: "Output"; readonly text: string }
  | { readonly _tag: "End"; readonly exitCode: number; readonly error?: string | undefined }

export interface StartOptions {
  readonly command: string
  readonly envs?: Readonly<Record<string, string>> | undefined
  readonly cwd?: string | undefined
  /** Run in a pseudo-terminal of this size (TERM=xterm-256color). */
  readonly pty?: { readonly cols: number; readonly rows: number } | undefined
  readonly user?: string | undefined
}

export interface RunResult {
  readonly exitCode: number
  readonly output: string
}

const envdUrl = (sandbox: SandboxAccess) => `https://${EnvdPort}-${sandbox.sandboxId}.${sandbox.domain}`

/** Connect's streaming envelope: one flag byte, a 4-byte big-endian length, then the JSON message. */
export const encodeEnvelope = (message: unknown): Uint8Array<ArrayBuffer> => {
  const body = utf8(JSON.stringify(message))
  const out = new Uint8Array(5 + body.length)
  new DataView(out.buffer).setUint32(1, body.length)
  out.set(body, 5)
  return out
}

/** Splits a byte stream into Connect envelopes: `[flags, json]`. Flag 0x02 marks the end-of-stream trailer. */
export const decodeEnvelopes = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>
): Stream.Stream<readonly [number, string], E, R> =>
  Stream.suspend(() => {
    let buffer = new Uint8Array(0)
    return bytes.pipe(
      Stream.mapArray((chunks) => {
        const out: Array<readonly [number, string]> = []
        for (const chunk of chunks) {
          const next = new Uint8Array(buffer.length + chunk.length)
          next.set(buffer)
          next.set(chunk, buffer.length)
          buffer = next
          while (buffer.length >= 5) {
            const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1)
            if (buffer.length < 5 + length) break
            out.push([buffer[0]!, fromUtf8(buffer.subarray(5, 5 + length))])
            buffer = buffer.slice(5 + length)
          }
        }
        return out as any
      })
    )
  })

const decodeEvent = (json: string): ReadonlyArray<ProcessOutput> => {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(StreamMessage))(json)
  if (Option.isNone(decoded)) return []
  const event = decoded.value.event
  const out: Array<ProcessOutput> = []
  if (event.start !== undefined) out.push({ _tag: "Start", pid: event.start.pid })
  if (event.data !== undefined) {
    const chunk = event.data.pty ?? event.data.stdout ?? event.data.stderr
    if (chunk !== undefined) out.push({ _tag: "Output", text: fromUtf8(fromBase64(chunk)) })
  }
  if (event.end !== undefined) {
    out.push({
      _tag: "End",
      exitCode: event.end.exitCode ?? 0,
      ...(event.end.error === undefined ? {} : { error: event.end.error })
    })
  }
  return out
}

const basicUser = (user: string) => `Basic ${btoa(`${user}:`)}`

export class Envd extends Context.Service<
  Envd,
  {
    /** Starts a process and streams what it does, beginning with `Start`. Interrupting the stream leaves the process running. */
    readonly start: (sandbox: SandboxAccess, options: StartOptions) => Stream.Stream<ProcessOutput, UpstreamFailure>
    /** Reattaches to a running process's output (from now on). */
    readonly attach: (sandbox: SandboxAccess, pid: number) => Stream.Stream<ProcessOutput, UpstreamFailure>
    /** Starts a process and returns its pid without waiting for it. */
    readonly startBackground: (sandbox: SandboxAccess, options: StartOptions) => Effect.Effect<number, UpstreamFailure>
    /** Runs a command to completion (or `timeout`) and returns its combined output. */
    readonly run: (
      sandbox: SandboxAccess,
      options: StartOptions & { readonly timeout?: Duration.Input | undefined }
    ) => Effect.Effect<RunResult, UpstreamFailure>
    readonly sendInput: (
      sandbox: SandboxAccess,
      pid: number,
      text: string,
      pty: boolean
    ) => Effect.Effect<void, UpstreamFailure>
    readonly kill: (sandbox: SandboxAccess, pid: number) => Effect.Effect<void>
    readonly writeFile: (
      sandbox: SandboxAccess,
      path: string,
      content: string,
      user?: string
    ) => Effect.Effect<void, UpstreamFailure>
    /** The file's text, or none if it doesn't exist. */
    readonly readFile: (
      sandbox: SandboxAccess,
      path: string,
      user?: string
    ) => Effect.Effect<Option.Option<string>, UpstreamFailure>
  }
>()("@dream/api/Envd") {
  static readonly layer = Layer.effect(
    Envd,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient

      const failure = (what: string) => (cause: unknown) =>
        new UpstreamFailure({ service: "E2B", message: `${what} failed: ${describe(cause)}` })

      const rpcStream = (sandbox: SandboxAccess, method: string, message: unknown, user: string) =>
        HttpClientRequest.post(`${envdUrl(sandbox)}/process.Process/${method}`).pipe(
          HttpClientRequest.setHeaders({
            "content-type": "application/connect+json",
            "connect-protocol-version": "1",
            "x-access-token": sandbox.envdAccessToken,
            authorization: basicUser(user),
            "keepalive-ping-interval": "50"
          }),
          HttpClientRequest.bodyUint8Array(encodeEnvelope(message), "application/connect+json"),
          http.execute,
          Effect.flatMap(okOrFail),
          Effect.mapError(failure(`envd ${method}`)),
          Effect.map((response) =>
            decodeEnvelopes(response.stream.pipe(Stream.mapError(failure(`envd ${method}`)))).pipe(
              Stream.flatMap(([flags, json]) =>
                flags & 0x02
                  ? json.includes('"error"')
                    ? Stream.fail(failure(`envd ${method}`)(json))
                    : Stream.empty
                  : Stream.fromIterable(decodeEvent(json))
              )
            )
          ),
          Stream.unwrap
        )

      const unary = (sandbox: SandboxAccess, method: string, message: unknown, user: string = DefaultUser) =>
        HttpClientRequest.post(`${envdUrl(sandbox)}/process.Process/${method}`).pipe(
          HttpClientRequest.setHeaders({
            "connect-protocol-version": "1",
            "x-access-token": sandbox.envdAccessToken,
            authorization: basicUser(user)
          }),
          HttpClientRequest.bodyJsonUnsafe(message),
          http.execute,
          Effect.flatMap(okOrFail),
          Effect.asVoid,
          Effect.mapError(failure(`envd ${method}`))
        )

      const start = (sandbox: SandboxAccess, options: StartOptions) =>
        rpcStream(
          sandbox,
          "Start",
          {
            process: {
              cmd: "/bin/bash",
              args: ["-l", "-c", options.command],
              envs: options.pty === undefined ? (options.envs ?? {}) : { TERM: "xterm-256color", ...options.envs },
              ...(options.cwd === undefined ? {} : { cwd: options.cwd })
            },
            ...(options.pty === undefined
              ? { stdin: false }
              : { pty: { size: { cols: options.pty.cols, rows: options.pty.rows } } })
          },
          options.user ?? DefaultUser
        )

      const attach = (sandbox: SandboxAccess, pid: number) =>
        rpcStream(sandbox, "Connect", { process: { pid } }, DefaultUser)

      const startBackground = (sandbox: SandboxAccess, options: StartOptions) =>
        start(sandbox, options).pipe(
          Stream.filter((event) => event._tag === "Start"),
          Stream.runHead,
          Effect.flatMap((first) =>
            Option.match(first, {
              onNone: () => Effect.fail(failure("Starting a process")("envd didn't report a pid")),
              onSome: (event) => Effect.succeed((event as { readonly pid: number }).pid)
            })
          ),
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(failure("Starting a process")("timed out"))
          })
        )

      const run = (sandbox: SandboxAccess, options: StartOptions & { readonly timeout?: Duration.Input | undefined }) =>
        start(sandbox, options).pipe(
          Stream.runFold(
            () => ({ exitCode: -1, output: "" }),
            (acc, event) =>
              event._tag === "Output"
                ? { ...acc, output: acc.output + event.text }
                : event._tag === "End"
                  ? { ...acc, exitCode: event.exitCode }
                  : acc
          ),
          Effect.timeoutOrElse({
            duration: options.timeout ?? "60 seconds",
            orElse: () => Effect.fail(failure(`Running \`${options.command}\``)("timed out"))
          })
        )

      const sendInput = (sandbox: SandboxAccess, pid: number, text: string, pty: boolean) =>
        unary(sandbox, "SendInput", {
          process: { pid },
          input: pty ? { pty: toBase64(utf8(text)) } : { stdin: toBase64(utf8(text)) }
        })

      const kill = (sandbox: SandboxAccess, pid: number) =>
        unary(sandbox, "SendSignal", { process: { pid }, signal: "SIGNAL_SIGKILL" }).pipe(Effect.ignore)

      const writeFile = (sandbox: SandboxAccess, path: string, content: string, user: string = DefaultUser) =>
        HttpClientRequest.post(`${envdUrl(sandbox)}/files`).pipe(
          HttpClientRequest.setUrlParams({ path, username: user }),
          HttpClientRequest.setHeaders({ "x-access-token": sandbox.envdAccessToken }),
          HttpClientRequest.bodyUint8Array(utf8(content), "application/octet-stream"),
          http.execute,
          Effect.flatMap(okOrFail),
          Effect.asVoid,
          Effect.mapError(failure(`Writing ${path}`))
        )

      const readFile = (sandbox: SandboxAccess, path: string, user: string = DefaultUser) =>
        Effect.gen(function* () {
          const response = yield* HttpClientRequest.get(`${envdUrl(sandbox)}/files`).pipe(
            HttpClientRequest.setUrlParams({ path, username: user }),
            HttpClientRequest.setHeaders({ "x-access-token": sandbox.envdAccessToken }),
            http.execute,
            Effect.mapError(failure(`Reading ${path}`))
          )
          if (response.status === 404) return Option.none<string>()
          const ok = yield* okOrFail(response).pipe(Effect.mapError(failure(`Reading ${path}`)))
          return Option.some(yield* ok.text.pipe(Effect.mapError(failure(`Reading ${path}`))))
        })

      return Envd.of({ start, attach, startBackground, run, sendInput, kill, writeFile, readFile })
    })
  )
}

export type { HttpClientResponse }
