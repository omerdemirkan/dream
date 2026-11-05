/**
 * The Worker's over-the-air update routes on this machine, for checking expo-updates end to end without deploying:
 * the real router and handlers over the test D1 and R2 stand-ins, kept in a directory so the signing key (and the
 * certificate a test build embeds) survive a restart.
 *
 *   DREAM_UPDATES_SECRET=… PUBLIC_URL=https://… node apps/api/scripts/updates-dev-server.ts
 *
 * PUBLIC_URL is where the app reaches it (asset URLs in manifests point there); PORT defaults to 8787 and
 * DREAM_UPDATES_DEV_DIR to /tmp/dream-updates-dev. Then point `apps/mobile/scripts/updates.ts` at it with
 * DREAM_API_URL and DREAM_UPDATES_SECRET, and a build at it with DREAM_UPDATES_URL.
 *
 * To check that the app refuses bad updates, write one of these to <dir>/mode; manifest responses change from the
 * next request on (an empty file or none serves them as they are):
 *   unsigned       drops the manifest's expo-signature
 *   wrong-key      signs the manifest with another key
 *   tampered       changes the manifest after it was signed
 *   wrong-runtime  serves the manifest for another runtime version, correctly signed
 */
import { Effect, Layer, Option, Redacted } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { UpdateStore } from "../src/db/Updates.ts"
import { route } from "../src/http/Router.ts"
import { generateSigningKey, importSigningKey, signatureHeader } from "../src/lib/CodeSigning.ts"
import { makeCloud } from "../test/support/Cloud.ts"
import { makeR2 } from "../test/support/R2.ts"

const node = (globalThis as any).process
const http = node.getBuiltinModule("node:http")
const fs = node.getBuiltinModule("node:fs")
const env = node.env as Record<string, string | undefined>

const secret = env.DREAM_UPDATES_SECRET
const publicUrl = (env.PUBLIC_URL ?? "").replace(/\/+$/, "")
if (secret === undefined || !publicUrl.startsWith("http")) {
  console.error("Set DREAM_UPDATES_SECRET and PUBLIC_URL (see the header).")
  node.exit(2)
}
const dir = env.DREAM_UPDATES_DEV_DIR ?? "/tmp/dream-updates-dev"
const port = Number(env.PORT ?? 8787)
fs.mkdirSync(dir, { recursive: true })
const apiHost = new URL(publicUrl).host

const cloud = await Effect.runPromise(
  makeCloud(
    { apiHost, apiUrl: publicUrl, updatesPublishSecret: Option.some(Redacted.make(secret!)) },
    { updates: makeR2(`${dir}/r2`).bucket, databasePath: `${dir}/d1.sqlite` }
  )
)
const context = Layer.succeedContext(cloud.workerContext)
const otherKey = await Effect.runPromise(
  Effect.flatMap(generateSigningKey("Not Dream"), (k) => importSigningKey(k.privateKeyPkcs8))
)

/** Rewrites a manifest response for the test modes. */
const misbehave = async (mode: string, response: Response): Promise<Response> => {
  const type = response.headers.get("content-type") ?? ""
  const boundary = /boundary=(.+)$/.exec(type)?.[1]
  if (boundary === undefined) return response
  const body = await response.text()
  const parts = body.split(`--${boundary}`)
  const index = parts.findIndex((p) => p.includes('name="manifest"'))
  if (index === -1) return new Response(body, response)
  const [head, json] = parts[index]!.split("\r\n\r\n") as [string, string]
  const manifest = json.replace(/\r\n$/, "")
  const resign = async (text: string, key = "real") => {
    const signing =
      key === "real"
        ? Option.getOrThrow(
            await Effect.runPromise(
              Effect.gen(function* () {
                return yield* (yield* UpdateStore).signingKey
              }).pipe(Effect.provide(context))
            )
          ).key
        : otherKey
    const signature = await Effect.runPromise(signatureHeader(signing, text, "main"))
    return [head.replace(/expo-signature: .*\r\n/, `expo-signature: ${signature}\r\n`), text]
  }
  let next: [string, string]
  if (mode === "unsigned") next = [head.replace(/expo-signature: .*\r\n/, ""), manifest]
  else if (mode === "wrong-key") next = (await resign(manifest, "other")) as [string, string]
  else if (mode === "tampered")
    next = [head, manifest.replace(/"createdAt":"[^"]+"/, `"createdAt":"${new Date().toISOString()}"`)]
  else if (mode === "wrong-runtime")
    next = (await resign(manifest.replace(/"runtimeVersion":"[^"]+"/, '"runtimeVersion":"not-this-build"'))) as [
      string,
      string
    ]
  else return new Response(body, response)
  parts[index] = `${next[0]}\r\n\r\n${next[1]}\r\n`
  console.log(`  (${mode})`)
  return new Response(parts.join(`--${boundary}`), { status: response.status, headers: response.headers })
}

const handle = async (req: any, res: any) => {
  const chunks: Array<Uint8Array> = []
  for await (const chunk of req) chunks.push(chunk)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers as Record<string, string | Array<string>>))
    headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  const hasBody = req.method !== "GET" && req.method !== "HEAD"
  const raw = new Request(`https://${apiHost}${req.url}`, {
    method: req.method,
    headers,
    ...(hasBody ? { body: new Blob(chunks as Array<any>) } : {})
  })
  let response = HttpServerResponse.toWeb(
    await Effect.runPromise(
      route(raw).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
        Effect.provide(context),
        Effect.scoped
      )
    )
  )
  const mode = fs.existsSync(`${dir}/mode`) ? fs.readFileSync(`${dir}/mode`, "utf8").trim() : ""
  if (new URL(raw.url).pathname === "/updates/manifest" && response.status === 200 && mode !== "")
    response = await misbehave(mode, response)
  console.log(
    `${req.method} ${req.url} → ${response.status}` +
      (req.headers["expo-runtime-version"]
        ? ` (runtime ${req.headers["expo-runtime-version"]}, channel ${req.headers["expo-channel-name"]})`
        : "")
  )
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(req.method === "HEAD" ? undefined : new Uint8Array(await response.arrayBuffer()))
}

http
  .createServer((req: any, res: any) =>
    handle(req, res).catch((e) => {
      console.error(e)
      res.writeHead(500)
      res.end("error")
    })
  )
  .listen(port, () => console.log(`updates dev server on :${port}, public at ${publicUrl}, data in ${dir}`))
