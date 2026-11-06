/**
 * The gateway for published apps: `<slug>-<random>.<domain>` → the project's
 * sandbox port URL, with the sandbox's traffic token (which only Dream holds).
 * A request to a paused sandbox resumes it. WebSocket upgrades pass through.
 *
 * Where they have an app link to the host, the gateway also makes Safari's Add to Home Screen come out right: it
 * serves a web app manifest and a touch icon from the link's title and tile (under `DreamAssets`), points the
 * app's HTML at them, and, when Dream opened the page for this, shows Safari's steps once. The same title and tile
 * become the page's link preview (Messages, WhatsApp) where the app sets no Open Graph title or image of its own.
 */
import type { Element, EndTag, HTMLRewriter as Rewriter } from "@cloudflare/workers-types"
import type { LinkId, ProjectId, UserId } from "@dream/domain"
import { linkPath } from "@dream/domain"
import { Clock, Effect, Option } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { type LinkRow, Links, toAppLink } from "../db/Links.ts"
import { Projects } from "../db/Projects.ts"
import { HomeScreenHintParam } from "../links/AppLinks.ts"
import { MediaStore } from "./Media.ts"
import { ProjectClients } from "../project/Client.ts"
import type { GatewayTarget } from "../project/ProjectRpcs.ts"
import { ArchivedEntity } from "../project/SandboxManager.ts"

// Per-isolate caches: hosts never move between projects; targets are rechecked every minute.
const hostCache = new Map<string, { readonly projectId: ProjectId; readonly ownerId: UserId } | null>()
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

/**
 * The app can't answer yet: the sandbox is still coming up, or a request was cut off when it went to sleep. A browser
 * opening a page gets one that quietly tries again (sooner at first, then every 30 s); anything else, like an API
 * call or a WebSocket, gets a 503 it can retry.
 */
export const waking = (request: Request) => {
  const accept = request.headers.get("accept") ?? ""
  if ((request.method === "GET" || request.method === "HEAD") && accept.includes("text/html")) {
    return HttpServerResponse.text(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waking up</title>` +
        `<body style="font:16px system-ui;margin:20vh auto;max-width:28rem;padding:0 1.5rem;color:#222">` +
        `<h1 style="font-size:1.4rem">Waking up</h1><p>This takes a moment. The page opens by itself.</p>` +
        `<script>(function(){var k="dream-waking:"+location.pathname+location.search,` +
        `n=+(sessionStorage.getItem(k)||0);sessionStorage.setItem(k,n+1);` +
        `setTimeout(function(){location.reload()},Math.min(30000,1000*Math.pow(2,n)))})()</script></body>`,
      {
        status: 503,
        contentType: "text/html; charset=utf-8",
        headers: { "retry-after": "2", "cache-control": "no-store" }
      }
    )
  }
  return HttpServerResponse.text("Waking up. Try again in a moment.\n", {
    status: 503,
    headers: { "retry-after": "2", "cache-control": "no-store" }
  })
}

/** E2B's own 502, for a sandbox that's running with nothing listening on the port (yet), as opposed to the app's. */
export const portNotOpen = (response: Response) =>
  Effect.gen(function* () {
    if (response.status !== 502) return false
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) return false
    const body = yield* Effect.promise(() =>
      response
        .clone()
        .text()
        .catch(() => "")
    )
    return body.includes("port is not open")
  })

export const gateway = (host: string, raw: Request) =>
  Effect.gen(function* () {
    const projects = yield* Projects
    const clients = yield* ProjectClients
    let owned = hostCache.get(host)
    if (owned === undefined) {
      const found = yield* projects.byHost(host)
      owned = Option.getOrNull(found)
      hostCache.set(host, owned)
    }
    if (owned === null) return page(404, "Nothing here", "There's no app at this address.")
    const id = owned.projectId
    const incoming = new URL(raw.url)
    if (incoming.pathname.startsWith(DreamAssets)) return yield* homeScreenAsset(host, owned.ownerId, incoming.pathname)

    const now = yield* Clock.currentTimeMillis
    const cached = targetCache.get(id)
    let target: GatewayTarget
    if (cached !== undefined && now - cached.atMs < TargetTtlMs) {
      target = cached.target
    } else {
      const result = yield* clients.use(id, (client) => client.GatewayTarget()).pipe(Effect.result)
      if (result._tag === "Failure") {
        if (result.failure._tag !== "NotFound") return waking(raw)
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

    // Dream opened this page to add it to the Home Screen: the app never sees the marker.
    const hint = incoming.searchParams.has(HomeScreenHintParam)
    incoming.searchParams.delete(HomeScreenHintParam)
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
      return waking(raw)
    }
    if (response.value.status === 502 || response.value.status === 404) {
      // The sandbox may have been recreated; look it up again next time.
      targetCache.delete(id)
    }
    if (yield* portNotOpen(response.value)) {
      yield* Effect.promise(() => response.value.body?.cancel().catch(() => undefined) ?? Promise.resolve())
      return waking(raw)
    }
    return HttpServerResponse.raw(yield* withHomeScreenHead(host, owned.ownerId, incoming, response.value, hint))
  })

// ---------------------------------------------------------------------------
// Add to Home Screen
// ---------------------------------------------------------------------------

/** Paths the gateway answers itself on every published host. */
export const DreamAssets = "/.well-known/dream/"

const linkCache = new Map<
  string,
  { readonly rows: ReadonlyArray<LinkRow & { hasIcon: boolean }>; readonly atMs: number }
>()
const LinkTtlMs = 30_000

/** Their links to this host, with whether each has a touch icon. */
const linksFor = (host: string, ownerId: UserId) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const cached = linkCache.get(host)
    if (cached !== undefined && now - cached.atMs < LinkTtlMs) return cached.rows
    const links = yield* Links
    const rows = (yield* links.forHost(host)).filter((row) => row.user_id === ownerId)
    const withIcons = yield* Effect.forEach(rows, (row) =>
      row.icon_json?._tag === "Image"
        ? Effect.succeed({ ...row, hasIcon: true })
        : Effect.map(links.icon(row.id), (png) => ({ ...row, hasIcon: Option.isSome(png) }))
    )
    linkCache.set(host, { rows: withIcons, atMs: now })
    return withIcons
  })

/** The link whose path is the longest prefix of `path`. */
export const linkForPath = <A extends { readonly url: string }>(
  rows: ReadonlyArray<A>,
  path: string
): A | undefined => {
  let best: A | undefined
  let bestLength = -1
  for (const row of rows) {
    const prefix = linkPath(row.url).split(/[?#]/)[0] ?? "/"
    const base = prefix.replace(/\/$/, "")
    const matches = base === "" || path === base || path.startsWith(`${base}/`)
    if (matches && base.length > bestLength) {
      best = row
      bestLength = base.length
    }
  }
  return best
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c)

/** Tile colours as the phone draws them (the top of `linkTile`'s gradients in the app), for the manifest. */
const tileColors: Record<LinkRow["color"], string> = {
  red: "#FF7A6B",
  orange: "#FFC680",
  yellow: "#FFE07A",
  green: "#4F8E66",
  teal: "#5BD6C9",
  blue: "#62AEFF",
  purple: "#8E5CF7",
  pink: "#FF93C6",
  graphite: "#55555D",
  light: "#F6F4EE"
}

/** What goes into the page's head: its Home Screen name, manifest and icon, and the one-time steps. */
export const homeScreenHead = (
  link: { readonly id: LinkId; readonly title: string },
  options: { readonly hasIcon: boolean; readonly hint: boolean }
): { readonly first: string; readonly last: string } => {
  const title = escapeHtml(link.title)
  const last =
    `<meta name="apple-mobile-web-app-title" content="${title}">` +
    `<meta name="apple-mobile-web-app-capable" content="yes">` +
    `<link rel="manifest" href="${DreamAssets}manifest/${link.id}.webmanifest">` +
    (options.hasIcon ? `<link rel="apple-touch-icon" href="${DreamAssets}icon/${link.id}.png">` : "")
  const first = options.hint ? `<script>${hintScript(link.title)}</script>` : ""
  return { first, last }
}

/** Open Graph tags from their link, for a preview of the page, where the page doesn't set its own. */
export const previewTags = (
  link: { readonly id: LinkId; readonly title: string },
  options: {
    readonly origin: string
    readonly hasIcon: boolean
    readonly ownTitle: boolean
    readonly ownImage: boolean
  }
): string =>
  (options.ownTitle ? "" : `<meta property="og:title" content="${escapeHtml(link.title)}">`) +
  (options.ownImage || !options.hasIcon
    ? ""
    : `<meta property="og:image" content="${options.origin}${DreamAssets}icon/${link.id}.png">`)

/**
 * Takes the marker out of the address bar before the app's scripts run (so the icon they add opens the plain URL),
 * then points at Safari's ••• until they tap the page, or for 20 seconds (a tap on Safari's own bar doesn't reach it).
 */
const hintScript = (title: string) =>
  `(function(){try{var u=new URL(location.href);u.searchParams.delete(${JSON.stringify(HomeScreenHintParam)});` +
  `history.replaceState(history.state,"",u.pathname+u.search+u.hash)}catch(e){}` +
  `var show=function(){var d=document.createElement("div");d.setAttribute("role","status");` +
  `d.style.cssText="position:fixed;z-index:2147483647;left:12px;right:12px;bottom:16px;` +
  `background:#141417;color:#F5F5F7;border-radius:22px;padding:16px 18px;font:500 17px/1.3 -apple-system,system-ui,sans-serif;` +
  `box-shadow:0 12px 40px rgba(0,0,0,.35);-webkit-font-smoothing:antialiased";` +
  `d.innerHTML='<div>Tap <b style=\"letter-spacing:1px\">•••</b> then Share, then Add to Home Screen.</div>` +
  `<div style=\"margin-top:6px;font-size:14px;font-weight:400;color:rgba(245,245,247,.5)\"></div>` +
  `<span style=\"position:absolute;right:37px;bottom:-8px;width:18px;height:18px;background:#141417;transform:rotate(45deg);border-radius:3px\"></span>';` +
  `d.children[1].textContent="Shown because you asked Dream to add "+${JSON.stringify(title).replace(/</g, "\\u003c")}+". Gone once you tap.";` +
  `document.body.appendChild(d);var gone=function(){d.remove();removeEventListener("pointerdown",gone,true)};` +
  `addEventListener("pointerdown",gone,true);setTimeout(gone,20000)};` +
  `document.readyState==="loading"?addEventListener("DOMContentLoaded",show):show()})()`

/** The app's HTML with its Home Screen name and icon taken from their link, if they have one to this page. */
const withHomeScreenHead = (host: string, ownerId: UserId, url: URL, response: Response, hint: boolean) =>
  Effect.gen(function* () {
    const type = response.headers.get("content-type") ?? ""
    // workerd has it; Node (tests) doesn't, and gets the page as it is.
    const HTMLRewriter = (globalThis as { HTMLRewriter?: new () => Rewriter }).HTMLRewriter
    if (response.status !== 200 || !type.includes("text/html") || HTMLRewriter === undefined) return response
    const link = linkForPath(yield* linksFor(host, ownerId), url.pathname)
    if (link === undefined) return response
    const head = homeScreenHead(link, { hasIcon: link.hasIcon, hint })
    const replaced = head.last.length > 0
    const own = { title: false, image: false }
    return new HTMLRewriter()
      .on('meta[property="og:title"], meta[property="og:image"]', {
        element: (element: Element) => {
          if (element.getAttribute("property") === "og:title") own.title = true
          else own.image = true
        }
      })
      .on(
        'link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"], link[rel~="manifest"], meta[name="apple-mobile-web-app-title"]',
        {
          element: (element: Element) => {
            if (replaced && (link.hasIcon || !element.getAttribute("rel")?.includes("apple-touch-icon")))
              element.remove()
          }
        }
      )
      .on("head", {
        element: (element: Element) => {
          if (head.first.length > 0) element.prepend(head.first, { html: true })
          element.append(head.last, { html: true })
          // At </head>, once the page's own tags have gone by.
          element.onEndTag((end: EndTag) => {
            const tags = previewTags(link, {
              origin: `https://${host}`,
              hasIcon: link.hasIcon,
              ownTitle: own.title,
              ownImage: own.image
            })
            if (tags.length > 0) end.before(tags, { html: true })
          })
        }
      })
      .transform(response as never) as unknown as Response
  })

const assetPattern = /^\/\.well-known\/dream\/(icon|manifest)\/(lnk_[A-Za-z0-9]+)\.(png|webmanifest)$/

/** `DreamAssets` routes: a link's touch icon and its web app manifest, for links to this host. */
const homeScreenAsset = (host: string, ownerId: UserId, path: string) =>
  Effect.gen(function* () {
    const match = assetPattern.exec(path)
    const rows = yield* linksFor(host, ownerId)
    const row = match === null ? undefined : rows.find((r) => r.id === match[2])
    if (match === null || row === undefined) return page(404, "Nothing here", "There's no app at this address.")
    const links = yield* Links
    const fresh = { "cache-control": "public, max-age=300" }
    if (match[1] === "manifest") {
      const link = toAppLink(row)
      const color = tileColors[link.color]
      const manifest = {
        name: link.title,
        short_name: link.title,
        start_url: link.url,
        scope: "/",
        display: "standalone",
        background_color: color,
        theme_color: color,
        ...(row.hasIcon
          ? {
              icons: [{ src: `${DreamAssets}icon/${link.id}.png`, sizes: "180x180", type: "image/png", purpose: "any" }]
            }
          : {})
      }
      return HttpServerResponse.text(JSON.stringify(manifest), {
        contentType: "application/manifest+json",
        headers: fresh
      })
    }
    if (row.icon_json?._tag === "Image") {
      const media = yield* MediaStore
      const projects = yield* Projects
      const found = yield* projects.media(row.icon_json.media.id)
      if (Option.isNone(media.bucket) || Option.isNone(found)) return page(404, "Nothing here", "No icon.")
      const bucket = media.bucket.value
      const object = yield* Effect.promise(() => bucket.get(found.value.object_key))
      if (object === null) return page(404, "Nothing here", "No icon.")
      return HttpServerResponse.raw(
        new Response(object.body as never, { headers: { "content-type": found.value.ref_json.contentType, ...fresh } })
      )
    }
    const png = yield* links.icon(row.id)
    if (Option.isNone(png)) return page(404, "Nothing here", "No icon.")
    const bytes = Uint8Array.from(atob(png.value), (c) => c.charCodeAt(0))
    return HttpServerResponse.uint8Array(bytes, { contentType: "image/png", headers: fresh })
  })
