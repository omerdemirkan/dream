/**
 * Builds Dream's iPhone app on a Namespace Mac and uploads it to TestFlight. The App Store Connect key
 * comes from the founder's Namespace Vault, straight onto that Mac: nothing on this side ever holds it.
 * Run from the repo root with Node 24:
 *
 *   DREAM_ASC_KEY_SECRET_ID=sec_… node apps/mobile/scripts/testflight-namespace.ts check
 *       Starts a Mac, checks the key arrived (mode 0600, a P-256 key) and signs one read-only App Store
 *       Connect call with it (looks up the app record). Builds nothing. About 1 minute.
 *
 *   DREAM_ASC_KEY_SECRET_ID=sec_… node apps/mobile/scripts/testflight-namespace.ts testflight [--no-upload]
 *       The same, then ships the committed tree (`git archive HEAD`) to the Mac and runs
 *       `apps/mobile/scripts/build-ios.sh testflight` there. --no-upload exports a signed .ipa on the Mac
 *       and stops there. 15–25 minutes.
 *
 * How the key travels: CreateInstance starts a tiny "application" on the Mac whose environment has
 * DREAM_ASC_KEY_P8 resolved by Namespace from the vault secret (`envVars[].fromSecretId`). The application
 * writes it to ~/.dream-asc (umask 077), drops it from its own environment and sleeps; it has to keep
 * running, because a Mac whose application exits is destroyed. Then, over SSH, the key is normalized to
 * AuthKey_<id>.p8 (0600), used, and deleted, and the Mac is destroyed, also on failure or Ctrl-C.
 * Namespace launches the application as `su -l runner -c 'VAR=… cmd'`, so for the Mac's lifetime the value
 * is also in that root process's arguments and in /var/log/so.namespace.vmguest.log on the Mac: it is
 * readable to code running on the build Mac, as the key file is anyway, and to nothing else.
 *
 * Environment:
 *   DREAM_ASC_KEY_SECRET_ID   the vault secret holding AuthKey_<id>.p8 (its object id, `sec_…`; not secret)
 *   DREAM_ASC_KEY_ID          default 5G566N355S
 *   DREAM_ASC_ISSUER_ID       default 0e7009f1-c7f0-40f0-b12e-b76df2001875
 *   NAMESPACE_TOKEN           bearer token for the Compute API; unset in an Outerloop workspace, where the
 *                             namespace-compute connection adds it
 *   NAMESPACE_API_URL         default https://us.compute.namespaceapis.com
 *   DREAM_MAC_IMAGE           image the key application mounts (default: an empty image pushed to ttl.sh
 *                             and pinned by digest; nothing from it runs)
 *   DREAM_APPLE_TEAM_ID, DREAM_BUNDLE_ID, DREAM_API_URL, DREAM_BACKEND, DREAM_GOOGLE_IOS_CLIENT_ID,
 *   DREAM_GOOGLE_WEB_CLIENT_ID, DREAM_APS_ENVIRONMENT, BUILD_NUMBER   passed to build-ios.sh (see there)
 *
 * It prints no secret: not the key, not the Mac's SSH key, not the App Store Connect token.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

const mode = process.argv[2]
const noUpload = process.argv.includes("--no-upload")
if ((mode !== "check" && mode !== "testflight") || process.argv.slice(3).some((a) => a !== "--no-upload")) {
  console.error("usage: node apps/mobile/scripts/testflight-namespace.ts check | testflight [--no-upload]")
  process.exit(2)
}
const secretId = process.env.DREAM_ASC_KEY_SECRET_ID?.trim() ?? ""
if (!/^[A-Za-z0-9_-]+$/.test(secretId)) {
  console.error("set DREAM_ASC_KEY_SECRET_ID to the vault secret's object id (sec_…); see docs/setup/testflight.md")
  process.exit(2)
}
const keyId = process.env.DREAM_ASC_KEY_ID ?? "5G566N355S"
const issuerId = process.env.DREAM_ASC_ISSUER_ID ?? "0e7009f1-c7f0-40f0-b12e-b76df2001875"
const bundleId = process.env.DREAM_BUNDLE_ID ?? "build.omer.dream"
if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[0-9a-f-]{36}$/.test(issuerId)) {
  console.error("DREAM_ASC_KEY_ID must be a 10-character key id and DREAM_ASC_ISSUER_ID a uuid")
  process.exit(2)
}
const api = `${process.env.NAMESPACE_API_URL ?? "https://us.compute.namespaceapis.com"}/namespace.cloud.compute.v1beta.ComputeService`
const passThrough = [
  "DREAM_APPLE_TEAM_ID",
  "DREAM_BUNDLE_ID",
  "DREAM_API_URL",
  "DREAM_BACKEND",
  "DREAM_GOOGLE_IOS_CLIENT_ID",
  "DREAM_GOOGLE_WEB_CLIENT_ID",
  "DREAM_APS_ENVIRONMENT",
  "BUILD_NUMBER"
]

type Json = any

const log = (line: string) => console.log(`› ${line}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

const compute = async (method: string, body: object): Promise<Json> => {
  const token = process.env.NAMESPACE_TOKEN
  const res = await fetch(`${api}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  const json: Json = await res.json().catch(() => ({}))
  // Only the message: some responses (DescribeInstance, GetSSHConfig) carry the Mac's SSH key.
  if (!res.ok) throw new Error(`Namespace ${method}: ${res.status} ${json?.message ?? ""}`)
  return json
}

/** A one-file tar (ustar), so the image has a layer to mount. */
const tarOf = (name: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(512)
  header.write(name, 0)
  header.write("0000644\0", 100)
  header.write("0000000\0", 108)
  header.write("0000000\0", 116)
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124)
  header.write("00000000000\0", 136)
  header.write("        ", 148)
  header.write("0", 156)
  header.write("ustar\0", 257)
  header.write("00", 263)
  const sum = header.reduce((a, b) => a + b, 0)
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return Buffer.concat([header, padded, Buffer.alloc(1024)])
}

/**
 * macOS applications must mount an image (CreateInstance rejects one without: "no support disk selectors
 * specified"), even though the key application only runs /bin/sh. This pushes an empty darwin/arm64 image
 * to ttl.sh (anonymous, expires in an hour) and returns it pinned by digest, so the registry can't swap it.
 */
const pushEmptyImage = async (): Promise<string> => {
  const repo = `ttl.sh/dream-asc-${sha256(Buffer.from(`${Date.now()}${Math.random()}`)).slice(0, 12)}`
  const [host, name] = [repo.slice(0, repo.indexOf("/")), repo.slice(repo.indexOf("/") + 1)]
  const tar = tarOf(
    "README",
    Buffer.from("Dream: mounted by the App Store Connect key application. Nothing here runs.\n")
  )
  const layer = gzipSync(tar)
  const config = Buffer.from(
    JSON.stringify({
      architecture: "arm64",
      os: "darwin",
      rootfs: { type: "layers", diff_ids: [`sha256:${sha256(tar)}`] },
      config: {}
    })
  )
  const putBlob = async (blob: Buffer) => {
    const digest = `sha256:${sha256(blob)}`
    const start = await fetch(`https://${host}/v2/${name}/blobs/uploads/`, { method: "POST" })
    const location = start.headers.get("location")
    if (start.status !== 202 || !location) throw new Error(`ttl.sh upload: ${start.status}`)
    const url = new URL(location, `https://${host}`)
    url.searchParams.set("digest", digest)
    const put = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(blob)
    })
    if (put.status !== 201) throw new Error(`ttl.sh blob: ${put.status}`)
    return { digest, size: blob.length }
  }
  const configRef = await putBlob(config)
  const layerRef = await putBlob(layer)
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...configRef },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", ...layerRef }]
    })
  )
  const put = await fetch(`https://${host}/v2/${name}/manifests/1h`, {
    method: "PUT",
    headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
    body: new Uint8Array(manifest)
  })
  if (put.status !== 201) throw new Error(`ttl.sh manifest: ${put.status}`)
  return `${repo}@sha256:${sha256(manifest)}`
}

/** Runs on the Mac (Node from Homebrew): normalizes the delivered key, checks it, and signs one read-only call. */
const checkKeyOnMac = String.raw`
const fs = require("node:fs"), crypto = require("node:crypto")
const [keyId, issuerId, bundleId] = process.argv.slice(2)
const dir = process.env.HOME + "/.dream-asc", delivered = dir + "/delivered", out = dir + "/AuthKey_" + keyId + ".p8"
const report = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1) }
if (!fs.existsSync(delivered)) report({ ok: false, problem: "the key application didn't write the key" })
const st = fs.statSync(delivered), raw = fs.readFileSync(delivered, "utf8")
const facts = { bytes: raw.length, mode: (st.mode & 0o777).toString(8), dirMode: (fs.statSync(dir).mode & 0o777).toString(8),
  sha256: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12) }
// The vault may hold the .p8 as pasted (newlines possibly flattened to spaces) or base64 of the file.
let text = raw
if (!text.includes("-----BEGIN")) { try { text = Buffer.from(raw.trim(), "base64").toString("utf8") } catch {} }
const m = text.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/)
if (!m) report({ ok: false, ...facts, problem: "not a .p8 (no BEGIN/END PRIVATE KEY)" })
const body = m[1].replace(/\s+/g, "")
const pem = "-----BEGIN PRIVATE KEY-----\n" + (body.match(/.{1,64}/g) || []).join("\n") + "\n-----END PRIVATE KEY-----\n"
let key
try { key = crypto.createPrivateKey(pem) } catch { report({ ok: false, ...facts, problem: "the .p8 doesn't parse" }) }
if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
  report({ ok: false, ...facts, problem: "not an App Store Connect key (P-256)" })
fs.writeFileSync(out, pem, { mode: 0o600 })
fs.chmodSync(out, 0o600)
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const now = Math.floor(Date.now() / 1000)
const unsigned = b64({ alg: "ES256", kid: keyId, typ: "JWT" }) + "." + b64({ iss: issuerId, iat: now, exp: now + 300, aud: "appstoreconnect-v1" })
const jwt = unsigned + "." + crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")
fetch("https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=" + bundleId + "&fields[apps]=name,bundleId",
  { headers: { authorization: "Bearer " + jwt } })
  .then(async (r) => {
    const j = await r.json().catch(() => ({}))
    const app = j.data?.[0]?.attributes
    report({ ok: r.ok && !!app, ...facts, path: out, appStoreConnect: r.status, app: app?.name,
      problem: r.ok ? (app ? undefined : "no app record for " + bundleId)
        : "App Store Connect refused it (" + r.status + "): " + (j.errors?.[0]?.detail ?? "") })
  })
  .catch((e) => report({ ok: false, ...facts, problem: "App Store Connect unreachable: " + e.message }))
`

let instanceId: string | undefined
let workDir: string | undefined

const destroy = async () => {
  if (instanceId) {
    const id = instanceId
    instanceId = undefined
    await compute("DestroyInstance", { instanceId: id }).then(
      () => log(`Destroyed Mac ${id}`),
      (e) => console.error(`Destroying Mac ${id} failed (${e.message}): destroy it in the Namespace dashboard`)
    )
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void destroy().finally(() => process.exit(130)))

const run = (command: string, args: Array<string>, input?: string | NodeJS.ReadableStream) =>
  new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] })
    let stdout = ""
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }))
    if (typeof input === "string") child.stdin.end(input)
    else if (input) input.pipe(child.stdin)
    else child.stdin.end()
  })

const main = async () => {
  if (mode === "testflight") {
    const dirty = await run("git", ["status", "--porcelain", "--untracked-files=no"])
    if (dirty.stdout.trim()) log("Uncommitted changes aren't shipped: the Mac builds HEAD")
  }

  const image = process.env.DREAM_MAC_IMAGE ?? (await pushEmptyImage())
  const keyDir = "$HOME/.dream-asc"
  const deadline = new Date(Date.now() + (mode === "check" ? 20 : 120) * 60_000).toISOString()
  log("Starting a Mac (macos.version=27.x) with the key from the vault")
  const created = await compute("CreateInstance", {
    shape: {
      virtualCpu: 6,
      memoryMegabytes: 14336,
      os: "macos",
      machineArch: "arm64",
      selectors: [{ name: "macos.version", value: "27.x" }]
    },
    documentedPurpose: "Dream: TestFlight build of the iPhone app",
    labels: [{ name: "dream", value: "testflight" }],
    deadline,
    applications: [
      {
        name: "dream-asc-key",
        imageRef: image,
        command: "/bin/sh",
        args: [
          "-c",
          `umask 077; mkdir -p "${keyDir}"; printf '%s' "$DREAM_ASC_KEY_P8" > "${keyDir}/delivered"; exec env -u DREAM_ASC_KEY_P8 sleep 86400`
        ],
        envVars: [{ name: "DREAM_ASC_KEY_P8", fromSecretId: secretId }]
      }
    ]
  }).catch((e: Error) => {
    if (e.message.includes("instance limit"))
      throw new Error(`${e.message}\nAnother Mac is running (one at a time on this plan); stop it first.`)
    throw e
  })
  instanceId = created.metadata.instanceId as string
  log(`Mac ${instanceId} created; waiting for it to run`)

  for (let i = 0; ; i++) {
    const described = await compute("DescribeInstance", { instanceId })
    const status: string = described.metadata?.status ?? "UNKNOWN"
    if (status === "RUNNING") break
    if (status !== "PENDING" || i >= 60)
      throw new Error(
        status === "PENDING"
          ? "The Mac stayed PENDING for 5 minutes. Namespace does that when the secret can't be resolved: check DREAM_ASC_KEY_SECRET_ID, and that the secret is in this workspace's vault."
          : `The Mac ended up ${status}`
      )
    await sleep(5_000)
  }

  workDir = mkdtempSync(join(tmpdir(), "dream-mac-"))
  const ssh = await compute("GetSSHConfig", { instanceId })
  const identity = join(workDir, "id")
  const knownHosts = join(workDir, "known_hosts")
  writeFileSync(identity, Buffer.from(ssh.sshPrivateKey, "base64"), { mode: 0o600 })
  const hostKeys: Array<string> = ssh.sshHostKeys ?? []
  writeFileSync(
    knownHosts,
    hostKeys.map((k) => `${ssh.endpoint} ${Buffer.from(k, "base64").toString("utf8").trim()}\n`).join(""),
    { mode: 0o600 }
  )
  const sshArgs = [
    "-i",
    identity,
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    `StrictHostKeyChecking=${hostKeys.length > 0 ? "yes" : "accept-new"}`,
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "LogLevel=ERROR",
    `${ssh.username}@${ssh.endpoint}`
  ]
  const onMac = (script: string, input?: string | NodeJS.ReadableStream) => run("ssh", [...sshArgs, script], input)

  // The application writes the key a moment after the Mac reports RUNNING.
  for (let i = 0; i < 20; i++) {
    if ((await onMac(`test -s ${keyDir}/delivered`)).code === 0) break
    await sleep(3_000)
  }
  log("Checking the key on the Mac")
  const checked = await onMac(`PATH=/opt/homebrew/bin:$PATH node - ${keyId} ${issuerId} ${bundleId}`, checkKeyOnMac)
  const report: Json = JSON.parse(checked.stdout.trim().split("\n").pop() || "{}")
  const facts = `${report.bytes ?? "?"} bytes, mode ${report.mode ?? "?"} in a ${report.dirMode ?? "?"} directory, sha256 ${report.sha256 ?? "?"}…`
  if (!report.ok) throw new Error(`The key isn't usable: ${report.problem ?? "unknown"} (${facts})`)
  log(`Key arrived (${facts}); App Store Connect answered ${report.appStoreConnect} for "${report.app}"`)

  if (mode === "testflight") {
    log("Shipping HEAD to the Mac")
    const archive = spawn("git", ["archive", "--format=tar", "HEAD"], { stdio: ["ignore", "pipe", "inherit"] })
    const shipped = await onMac("rm -rf dream && mkdir dream && tar -x -C dream", archive.stdout)
    if (shipped.code !== 0) throw new Error("Shipping the tree failed")
    const env = passThrough
      .filter((name) => process.env[name] !== undefined)
      .map((name) => `${name}=${quote(process.env[name] ?? "")}`)
      .join(" ")
    const build = [
      "set -euo pipefail",
      'export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"',
      "command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 >/dev/null",
      "cd dream",
      `${env} ${noUpload ? "ASC_EXPORT_ONLY=1 " : ""}apps/mobile/scripts/build-ios.sh testflight --asc-key-path ${keyDir}/AuthKey_${keyId}.p8 --asc-key-id ${keyId} --asc-issuer-id ${issuerId}`
    ].join("\n")
    const child = spawn("ssh", [...sshArgs, `bash -c ${quote(build)}`], { stdio: ["ignore", "inherit", "inherit"] })
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)))
    if (code !== 0) throw new Error(`build-ios.sh failed (exit ${code})`)
  }

  await onMac(`rm -rf ${keyDir}`)
  log("Deleted the key from the Mac")
}

main()
  .then(destroy)
  .catch(async (e: Error) => {
    console.error(`✗ ${e.message}`)
    await destroy()
    process.exit(1)
  })
