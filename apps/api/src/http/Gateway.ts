/**
 * The gateway for published apps: `<slug>-<random>.<domain>` → the project's
 * sandbox port URL, with the sandbox's traffic token (which only Dream holds).
 * A request to a paused sandbox resumes it. WebSocket upgrades pass through.
 */
import type { ProjectId } from "@dream/domain"
import { Clock, Effect, Option } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Projects } from "../db/Projects.ts"
import { ProjectClients } from "../project/Client.ts"
import type { GatewayTarget } from "../project/ProjectRpcs.ts"
import { ArchivedEntity } from "../project/SandboxManager.ts"

// Per-isolate caches: hosts never move between projects; targets are rechecked every minute.
const hostCache = new Map<string, ProjectId | null>()
const targetCache = new Map<ProjectId, { readonly target: GatewayTarget; readonly atMs: number }>()
const TargetTtlMs = 60_000

const hopByHop = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "host"]

const page = (status: number, title: string, body: string) =>
  HttpServerResponse.text(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font:16px system-ui;margin:20vh auto;max-width:28rem;padding:0 1.5rem;color:#222">` +
      `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`,
    { status, contentType: "text/html; charset=utf-8" }
  )

export const gateway = (host: string, raw: Request) =>
  Effect.gen(function* () {
    const projects = yield* Projects
    const clients = yield* ProjectClients
    let projectId = hostCache.get(host)
    if (projectId === undefined) {
      const found = yield* projects.byHost(host)
      projectId = Option.match(found, { onNone: () => null, onSome: (p) => p.projectId })
      hostCache.set(host, projectId)
    }
    if (projectId === null) return page(404, "Nothing here", "There's no app at this address.")
    const id = projectId

    const now = yield* Clock.currentTimeMillis
    const cached = targetCache.get(id)
    let target: GatewayTarget
    if (cached !== undefined && now - cached.atMs < TargetTtlMs) {
      target = cached.target
    } else {
      const result = yield* clients.use(id, (client) => client.GatewayTarget()).pipe(Effect.result)
      if (result._tag === "Failure") {
        if (result.failure._tag !== "NotFound") {
          return page(502, "Waking up", "The app couldn't be reached just now. Try again in a moment.")
        }
        if (result.failure.entity === "project") {
          // Deleted: forget the host, so this isolate asks D1 again (which knows nothing of it).
          hostCache.delete(host)
          return page(404, "Nothing here", "There's no app at this address.")
        }
        return result.failure.entity === ArchivedEntity
          ? page(
              404,
              "Put away for now",
              "Whoever made this app has archived it. It comes back here if they restore it."
            )
          : page(404, "Not published yet", "This app is still being built. It will appear here once it's published.")
      }
      target = result.success
      targetCache.set(id, { target, atMs: now })
    }

    const incoming = new URL(raw.url)
    const headers = new Headers(raw.headers)
    for (const name of hopByHop) if (name !== "connection" || headers.get("upgrade") === null) headers.delete(name)
    for (const name of [...headers.keys()]) if (name.startsWith("cf-")) headers.delete(name)
    headers.set("e2b-traffic-access-token", target.trafficAccessToken)
    headers.set("x-forwarded-host", host)
    headers.set("x-forwarded-proto", "https")
    const forwarded = new Request(`${target.origin}${incoming.pathname}${incoming.search}`, {
      method: raw.method,
      headers,
      body: raw.method === "GET" || raw.method === "HEAD" ? null : raw.body,
      redirect: "manual"
    })
    const response = yield* Effect.tryPromise(() => fetch(forwarded)).pipe(Effect.option)
    if (Option.isNone(response)) {
      targetCache.delete(id)
      return page(502, "Waking up", "The app couldn't be reached just now. Try again in a moment.")
    }
    if (response.value.status === 502 || response.value.status === 404) {
      // The sandbox may have been recreated; look it up again next time.
      targetCache.delete(id)
    }
    return HttpServerResponse.raw(response.value)
  })
