/**
 * Over-the-air updates of Dream's iPhone app, published to Dream's own Worker (apps/api/src/http/Updates.ts,
 * README "Over-the-air updates"). Run from the repo root:
 *
 *   node apps/mobile/scripts/updates.ts init
 *       Once: has the Worker create its signing key (it never leaves the Worker) and writes the certificate to
 *       apps/mobile/certs/updates-certificate.pem, to commit. Builds embed it; without it they take no updates.
 *
 *   node apps/mobile/scripts/updates.ts publish [--channel production] [--message "…"] [--force]
 *       Exports the committed app (`expo export`) with the same config as the channel's builds, uploads what the
 *       Worker doesn't have yet, and makes it the live update for the runtime version those builds have.
 *       Refuses uncommitted changes; the production channel publishes only main as pushed to origin. --force
 *       publishes for a runtime version no build on the channel has asked with yet.
 *
 *   node apps/mobile/scripts/updates.ts rollback [--channel production] [--to <update id>|embedded] [--runtime <v>]
 *       Makes the update before the live one live again (as a new update, since phones only move forward), or the
 *       named one, or the bundle inside the build. The runtime version defaults to the one publish would use.
 *
 *   node apps/mobile/scripts/updates.ts status [--channel production]
 *       Per runtime version: what's live, the history, and when a build last asked and what it was running.
 *
 *   node apps/mobile/scripts/updates.ts runtime [--channel production]
 *       Prints the runtime version the channel's builds of this commit have.
 *
 * Channels: production (TestFlight builds), development (other builds against the live API), fixtures (the
 * sample world); the default is production. A build follows the channel build-env.sh gives it.
 *
 * Environment:
 *   DREAM_API_URL          default https://dream.omer.build
 *   DREAM_UPDATES_SECRET   UPDATES_PUBLISH_SECRET; by default read from D1 `dream-ops` with the Cloudflare
 *                          credentials (infra/scripts/updates-secret.ts). Never printed.
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN   for that read (the workspace connection adds the token)
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type PublishUpdateRequest,
  Routes,
  type UpdateAsset,
  UpdateRelease,
  UpdatesCertificate,
  UpdatesSecretHeader,
  UpdatesStatus
} from "@dream/domain"
import { DateTime, Schema } from "effect"

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(appDir, "../..")
const api = (process.env.DREAM_API_URL ?? "https://dream.omer.build").replace(/\/+$/, "")
const cloudflareAccount = process.env.CLOUDFLARE_ACCOUNT_ID ?? "2d98de7c4511e98d2f774c4fcc9b9b93"
const certificatePath = resolve(appDir, process.env.DREAM_UPDATES_CERTIFICATE ?? "certs/updates-certificate.pem")

const log = (line: string) => console.log(`› ${line}`)
const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const args = process.argv.slice(2)
const command = args[0]
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const flag = (name: string) => args.includes(`--${name}`)
const channel = option("channel") ?? "production"
if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel)) fail(`Bad channel: ${channel}`)

const run = (
  cmd: string,
  argv: ReadonlyArray<string>,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {}
) => {
  const result = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? repoRoot,
    env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) fail(`${cmd} ${argv.join(" ")} failed:\n${result.stderr || result.stdout}`)
  return result.stdout
}
const git = (...argv: ReadonlyArray<string>) => run("git", argv).trim()

/**
 * The environment the channel's builds are made with (build-env.sh), so the export carries the same app config and
 * the runtime version comes out the same as theirs.
 */
const channelEnv = (): Record<string, string> => {
  const mode = channel === "production" ? "testflight" : "simulator"
  const base = {
    ...process.env,
    DREAM_UPDATES_CHANNEL: channel,
    ...(channel === "fixtures" && process.env.DREAM_BACKEND === undefined ? { DREAM_BACKEND: "fixtures" } : {})
  }
  const out = run("bash", ["-c", '. "$0" "$1" >/dev/null && env -0', join(appDir, "scripts/build-env.sh"), mode], {
    env: base
  })
  return Object.fromEntries(
    out
      .split("\0")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  )
}

const bin = (name: string) => join(appDir, "node_modules/.bin", name)

const runtimeVersion = (env: Record<string, string>): string => {
  const out = run(bin("expo-updates"), ["runtimeversion:resolve", "--platform", "ios", "--workflow", "managed"], {
    cwd: appDir,
    env
  })
  const parsed = JSON.parse(out.slice(out.indexOf("{")))
  if (typeof parsed.runtimeVersion !== "string") fail(`No runtime version in: ${out.slice(0, 200)}`)
  return parsed.runtimeVersion
}

/** UPDATES_PUBLISH_SECRET, from the environment or the operator's D1 `dream-ops`. */
const publishSecret = async (): Promise<string> => {
  if (process.env.DREAM_UPDATES_SECRET) return process.env.DREAM_UPDATES_SECRET
  const token = process.env.CLOUDFLARE_API_TOKEN
  const cf = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token && token !== "anything" ? { authorization: `Bearer ${token}` } : {})
      }
    })
    const body: any = await res.json().catch(() => ({}))
    if (!body.success) fail(`Cloudflare ${path}: ${res.status}`)
    return body.result
  }
  const databases: Array<{ uuid: string; name: string }> = await cf("/d1/database?name=dream-ops")
  const ops = databases.find((db) => db.name === "dream-ops")
  if (!ops) return fail("No D1 dream-ops: run `node infra/scripts/updates-secret.ts ensure`")
  const [result] = await cf(`/d1/database/${ops.uuid}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT value FROM settings WHERE name = 'UPDATES_PUBLISH_SECRET'" })
  })
  const value = result?.results?.[0]?.value
  return typeof value === "string" ? value : fail("No UPDATES_PUBLISH_SECRET yet: run infra/scripts/updates-secret.ts")
}

let secret: Promise<string> | undefined
const operatorHeaders = async () => ({ [UpdatesSecretHeader]: await (secret ??= publishSecret()) })

const call = async <S extends Schema.Codec<any, any, never, never>>(
  schema: S,
  path: string,
  init: RequestInit = {}
): Promise<S["Type"]> => {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await operatorHeaders()), ...init.headers }
  })
  const text = await res.text()
  if (!res.ok) return fail(`${init.method ?? "GET"} ${path}: ${res.status} ${text}`)
  return Schema.decodeUnknownSync(Schema.toCodecJson(schema) as any)(JSON.parse(text)) as S["Type"]
}

const contentTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  json: "application/json"
}

const when = (at: DateTime.Utc) => DateTime.formatIso(at).slice(0, 19).replace("T", " ")

const describe = (release: UpdateRelease) =>
  UpdateRelease.match(release, {
    Update: (u) =>
      `${u.id}  ${when(u.createdAt)}  ${u.gitCommit.slice(0, 7)}  ${u.message}` +
      (u.republishOf === undefined ? "" : `  (again: ${u.republishOf.slice(0, 8)})`),
    RollBackToEmbedded: (r) => `${r.id}  ${when(r.createdAt)}  the build's own bundle`
  })

const init = async () => {
  const result = await call(UpdatesCertificate, Routes.updatesSigningKey, { method: "POST", body: "{}" })
  if (existsSync(certificatePath) && readFileSync(certificatePath, "utf8") !== result.certificatePem)
    fail(`${certificatePath} isn't the Worker's certificate. Builds embed it, so it's never replaced here.`)
  writeFileSync(certificatePath, result.certificatePem)
  log(result.created ? "Created the signing key on the Worker." : "The Worker already had its signing key.")
  log(`Certificate: ${certificatePath}. Commit it; the next build embeds it and is the baseline for updates.`)
}

const publish = async () => {
  if (git("status", "--porcelain") !== "") fail("Commit (or stash) your changes first: publish ships the commit.")
  const commit = git("rev-parse", "HEAD")
  if (channel === "production") {
    if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("The production channel publishes from main only.")
    git("fetch", "--quiet", "origin", "main")
    if (git("rev-parse", "origin/main") !== commit) fail("main isn't the same as origin/main: push or pull first.")
  }
  if (!existsSync(certificatePath)) fail("No signing certificate: run `updates.ts init` first.")
  const theirs = await fetch(`${api}${Routes.updatesCertificate}`).then((r) => r.json() as Promise<any>)
  if (theirs?.certificatePem !== readFileSync(certificatePath, "utf8"))
    fail("The Worker's signing certificate isn't the one in this commit: builds couldn't verify the update.")

  const env = { ...channelEnv(), CI: "1" }
  const runtime = runtimeVersion(env)
  log(`Channel ${channel}, runtime version ${runtime}, commit ${commit.slice(0, 7)}`)
  // The Worker checks this too; asking first saves an export when the answer is no.
  const known = (await call(UpdatesStatus, `${Routes.updatesStatus}?channel=${channel}`)).runtimes.some(
    (r) => r.runtimeVersion === runtime && r.checkIn !== undefined
  )
  if (!known && !flag("force"))
    fail(
      `No build on channel ${channel} has asked for updates with runtime version ${runtime}: the builds out there have ` +
        "different native code (see `status`), so this update can't reach them. Pass --force if the build isn't out yet."
    )
  const expoClient = JSON.parse(run(bin("expo"), ["config", "--type", "public", "--json"], { cwd: appDir, env }))
  const out = mkdtempSync(join(tmpdir(), "dream-update-"))
  try {
    log("Exporting the app (expo export)")
    run(bin("expo"), ["export", "--platform", "ios", "--output-dir", out], { cwd: appDir, env })
    const metadata = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8")).fileMetadata.ios as {
      bundle: string
      assets: Array<{ path: string; ext: string }>
    }
    const files: Array<{ asset: UpdateAsset; bytes: Buffer }> = []
    const describeFile = (path: string, contentType: string, ext?: string) => {
      const bytes = readFileSync(join(out, path))
      const asset: UpdateAsset = {
        hash: createHash("sha256").update(bytes).digest("base64url"),
        key: createHash("md5").update(bytes).digest("hex"),
        contentType,
        ...(ext === undefined ? {} : { fileExtension: `.${ext}` })
      }
      files.push({ asset, bytes })
      return asset
    }
    const launchAsset = describeFile(metadata.bundle, "application/javascript")
    const assets = metadata.assets.map((a) =>
      describeFile(a.path, contentTypes[a.ext.toLowerCase()] ?? "application/octet-stream", a.ext)
    )

    const headers = await operatorHeaders()
    let uploaded = 0
    for (const { asset, bytes } of files) {
      const path = `${api}${Routes.updatesUpload(asset.hash)}`
      if ((await fetch(path, { method: "HEAD", headers })).status === 200) continue
      const res = await fetch(path, {
        method: "PUT",
        headers: { ...headers, "content-type": asset.contentType },
        body: new Uint8Array(bytes)
      })
      if (res.status !== 201) fail(`Uploading ${asset.hash}: ${res.status} ${await res.text()}`)
      uploaded++
    }
    log(`Uploaded ${uploaded} of ${files.length} files (the rest were there already)`)

    const request: PublishUpdateRequest = {
      channel,
      platform: "ios",
      runtimeVersion: runtime,
      launchAsset,
      assets,
      expoClient,
      gitCommit: commit,
      message: (option("message") ?? git("log", "-1", "--format=%s")).slice(0, 500),
      ...(flag("force") ? { force: true } : {})
    }
    const release = await call(UpdateRelease, Routes.updatesPublish, { method: "POST", body: JSON.stringify(request) })
    log(`Live on ${channel}: ${describe(release)}`)
    log("Phones pick it up the next time Dream opens, and run it from the launch after (or Settings → Restart).")
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

const rollback = async () => {
  const runtime = option("runtime") ?? runtimeVersion(channelEnv())
  const to = option("to")
  const release = await call(UpdateRelease, Routes.updatesRollback, {
    method: "POST",
    body: JSON.stringify({ channel, platform: "ios", runtimeVersion: runtime, ...(to === undefined ? {} : { to }) })
  })
  log(`Live on ${channel} (runtime version ${runtime}): ${describe(release)}`)
}

const status = async () => {
  const result = await call(UpdatesStatus, `${Routes.updatesStatus}?channel=${channel}`)
  if (result.runtimes.length === 0) log(`Nothing on channel ${channel} yet.`)
  for (const runtime of result.runtimes) {
    console.log(`\n${runtime.platform} runtime version ${runtime.runtimeVersion}`)
    const check = runtime.checkIn
    console.log(
      check === undefined
        ? "  no build has asked yet"
        : `  last asked ${when(check.lastCheckAt)}, running ${check.runningUpdateId ?? "its embedded bundle"}`
    )
    const [live, ...earlier] = runtime.releases
    console.log(live === undefined ? "  live: the embedded bundle (nothing published)" : `  live: ${describe(live)}`)
    for (const release of earlier) console.log(`        ${describe(release)}`)
  }
}

const commands: Record<string, () => Promise<void>> = {
  init,
  publish,
  rollback,
  status,
  runtime: async () => console.log(runtimeVersion(channelEnv()))
}
const selected = command === undefined ? undefined : commands[command]
if (selected === undefined) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0])
  process.exit(2)
}
await selected()
