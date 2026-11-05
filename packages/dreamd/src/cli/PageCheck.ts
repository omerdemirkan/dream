/**
 * What a published URL answers when loaded from inside the sandbox, for
 * `dream publish` to print. It loads the page in the sandbox's headless
 * Chromium (through `load-page.cjs`, which uses the global Playwright) and
 * collects uncaught errors and failed requests; without a browser it fetches
 * the URL instead.
 */
import { fileURLToPath } from "node:url"
import { Context, Data, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const Via = Schema.Literals(["browser", "http"])

export const PageLoad = Schema.TaggedUnion({
  /** It answered; `status` is the document's. */
  Loaded: {
    via: Via,
    status: Schema.Int,
    contentType: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    /** The first line of visible text (or of the body, over HTTP). */
    firstLine: Schema.optionalKey(Schema.String),
    pageErrors: Schema.Array(Schema.String),
    consoleErrors: Schema.Array(Schema.String),
    /** `<status or network error> <url>` for subresources. */
    failedRequests: Schema.Array(Schema.String),
    /** It hadn't finished loading when the time was up. */
    stillLoading: Schema.Boolean
  },
  /** No response at all: refused, DNS, TLS, or nothing before the time was up. */
  Unreachable: { via: Via, message: Schema.String }
})
export type PageLoad = typeof PageLoad.Type

/** What `load-page.cjs` prints: a `PageLoad`, or why there's no browser to load it in. */
const BrowserOutput = Schema.fromJsonString(
  Schema.Union([PageLoad, Schema.TaggedStruct("Unavailable", { reason: Schema.String })])
)

export class PageCheckError extends Data.TaggedError("PageCheckError")<{ readonly message: string }> {}

/** How long the page gets to load and settle. */
export const loadTimeout = Duration.seconds(10)

const script = fileURLToPath(new URL("./load-page.cjs", import.meta.url))

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)

const htmlTitle = (html: string) =>
  html
    .match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim()

export class PageCheck extends Context.Service<
  PageCheck,
  { readonly check: (url: string) => Effect.Effect<PageLoad, PageCheckError> }
>()("@dream/dreamd/cli/PageCheck") {
  static readonly layer = Layer.effect(
    PageCheck,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const http = yield* HttpClient.HttpClient

      const inBrowser = (url: string) =>
        spawner
          .string(
            ChildProcess.make(process.execPath, [script, url, String(Duration.toMillis(loadTimeout))], {
              extendEnv: true,
              env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/playwright" }
            })
          )
          .pipe(
            Effect.mapError((cause) => new PageCheckError({ message: `the browser check failed: ${cause.message}` })),
            Effect.flatMap((output) =>
              Schema.decodeUnknownEffect(BrowserOutput)(output.trim()).pipe(
                Effect.mapError(() => new PageCheckError({ message: "the browser check printed nothing usable" }))
              )
            ),
            // Launching Chromium and closing it take time beyond the page's own.
            Effect.timeoutOrElse({
              duration: Duration.sum(loadTimeout, Duration.seconds(15)),
              orElse: () => Effect.fail(new PageCheckError({ message: "the browser check hung" }))
            })
          )

      const overHttp = (url: string) =>
        Effect.gen(function* () {
          const response = yield* http.get(url)
          const body = yield* response.text
          const contentType = response.headers["content-type"]
          const isHtml = contentType?.includes("html") === true
          const title = isHtml ? htmlTitle(body) : undefined
          const line = firstLine(isHtml ? body.replace(/<(script|style)[\s\S]*?<\/\1>|<[^>]+>/gi, "\n") : body)
          return PageLoad.cases.Loaded.make({
            via: "http",
            status: response.status,
            ...(contentType === undefined ? {} : { contentType }),
            ...(title ? { title } : {}),
            ...(line === undefined ? {} : { firstLine: line }),
            pageErrors: [],
            consoleErrors: [],
            failedRequests: [],
            stillLoading: false
          })
        }).pipe(
          Effect.timeoutOrElse({
            duration: loadTimeout,
            orElse: () =>
              Effect.succeed(
                PageLoad.cases.Unreachable.make({
                  via: "http",
                  message: `no response within ${Duration.format(loadTimeout)}`
                })
              )
          }),
          Effect.catch((error) =>
            Effect.succeed(PageLoad.cases.Unreachable.make({ via: "http", message: describeHttpError(error) }))
          )
        )

      return {
        check: Effect.fn("PageCheck.check")(function* (url: string) {
          const result = yield* inBrowser(url)
          return result._tag === "Unavailable" ? yield* overHttp(url) : result
        })
      }
    })
  )

  /** A check that answers `result` for every URL. */
  static readonly layerTest = (result: Effect.Effect<PageLoad, PageCheckError>) =>
    Layer.succeed(PageCheck, { check: () => result })
}

const describeHttpError = (error: { readonly message: string; readonly cause?: unknown }): string => {
  const cause = error.cause instanceof Error ? (error.cause.cause ?? error.cause) : undefined
  return cause instanceof Error ? cause.message : error.message
}
