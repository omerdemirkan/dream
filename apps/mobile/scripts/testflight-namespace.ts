/**
 * Builds Dream's iPhone app on a Namespace Mac and uploads it to TestFlight. The App Store Connect key is a
 * Worker secret (ASC_TESTFLIGHT_KEY_P8, set by the founder in the Cloudflare dashboard) that the Worker releases
 * only to this build Mac, encrypted to a key the Mac generated (see apps/api/src/http/Testflight.ts and
 * packages/domain/src/Testflight.ts). The key never passes through the machine running this script, an env var,
 * a command line, or a log. Run from the repo root with Node 24:
 *
 *   node apps/mobile/scripts/testflight-namespace.ts check
 *       Starts a Mac, has it fetch the key, checks it (a P-256 key, mode 0600) and signs one read-only App Store
 *       Connect call with it (looks up the app record). Builds nothing. About 1 minute.
 *
 *   node apps/mobile/scripts/testflight-namespace.ts testflight [--no-upload]
 *       The same, then ships the committed tree (`git archive HEAD`) to the Mac and runs
 *       `apps/mobile/scripts/build-ios.sh testflight` there. --no-upload exports a signed .ipa on the Mac
 *       and stops there. 15–25 minutes.
 *
 * How the key travels: this script creates the Mac (labeled dream=testflight) and grants its instance id with
 * the operator's DEV_LOGIN_SECRET (`/admin/testflight/grants`; single use, 15 minutes). Over SSH, a script fed on
 * stdin makes the Mac generate an ephemeral P-256 ECDH key, mint a Namespace ID token whose audience is bound to
 * that key (`nsc auth issue-id-token`, 5 minutes), and POST both to `/testflight/asc-key`. The Worker checks the
 * token against Namespace's JWKS, the tenant, the grant, and that this Mac is the workspace's only instance, then
 * returns the .p8 encrypted to the Mac's key; the Mac decrypts it into ~/.dream-asc (0600 in a 0700 directory).
 * After the build the key is deleted and the Mac destroyed, also on failure or Ctrl-C.
 *
 * Environment:
 *   DREAM_ASC_KEY_ID          default 5G566N355S
 *   DREAM_ASC_ISSUER_ID       default 0e7009f1-c7f0-40f0-b12e-b76df2001875
 *   DREAM_KEY_API_URL         the Worker that releases the key (default DREAM_API_URL, else https://dream.omer.build)
 *   DREAM_DEV_SECRET          the operator secret for the grant; by default read from D1 `dream-ops` through the
 *                             Cloudflare API (the workspace's cloudflare-api connection, or CLOUDFLARE_API_TOKEN)
 *   NAMESPACE_TOKEN           bearer token for the Compute API; unset in an Outerloop workspace, where the
 *                             namespace-compute connection adds it
 *   NAMESPACE_API_URL         default https://us.compute.namespaceapis.com
 *   DREAM_APPLE_TEAM_ID, DREAM_BUNDLE_ID, DREAM_API_URL, DREAM_BACKEND, DREAM_GOOGLE_IOS_CLIENT_ID,
 *   DREAM_GOOGLE_WEB_CLIENT_ID, DREAM_APS_ENVIRONMENT, BUILD_NUMBER   passed to build-ios.sh (see there)
 *
 * It prints no secret: not the key, not the ID token, not the Mac's SSH key, not the App Store Connect token.
 * Never put one on an SSH command line: Namespace logs every SSH command run on the Mac.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mode = process.argv[2]
const noUpload = process.argv.includes("--no-upload")
if ((mode !== "check" && mode !== "testflight") || process.argv.slice(3).some((a) => a !== "--no-upload")) {
  console.error("usage: node apps/mobile/scripts/testflight-namespace.ts check | testflight [--no-upload]")
  process.exit(2)
}
const keyId = process.env.DREAM_ASC_KEY_ID ?? "5G566N355S"
const issuerId = process.env.DREAM_ASC_ISSUER_ID ?? "0e7009f1-c7f0-40f0-b12e-b76df2001875"
const bundleId = process.env.DREAM_BUNDLE_ID ?? "build.omer.dream"
if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[0-9a-f-]{36}$/.test(issuerId)) {
  console.error("DREAM_ASC_KEY_ID must be a 10-character key id and DREAM_ASC_ISSUER_ID a uuid")
  process.exit(2)
}
const keyApi = (process.env.DREAM_KEY_API_URL ?? process.env.DREAM_API_URL ?? "https://dream.omer.build").replace(
  /\/+$/,
  ""
)
const api = `${process.env.NAMESPACE_API_URL ?? "https://us.compute.namespaceapis.com"}/namespace.cloud.compute.v1beta.ComputeService`
const cloudflareAccount = "2d98de7c4511e98d2f774c4fcc9b9b93"
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

/** DEV_LOGIN_SECRET, from the operator's D1 `dream-ops` (see infra/scripts/dev-login.ts). */
const devSecret = async (): Promise<string> => {
  if (process.env.DREAM_DEV_SECRET) return process.env.DREAM_DEV_SECRET
  const cf = async (path: string, init?: RequestInit): Promise<Json> => {
    const token = process.env.CLOUDFLARE_API_TOKEN
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token && token !== "anything" ? { authorization: `Bearer ${token}` } : {})
      }
    })
    const body: Json = await res.json().catch(() => ({}))
    if (!body.success) throw new Error(`Cloudflare ${path}: ${res.status}`)
    return body.result
  }
  const databases: Array<{ uuid: string; name: string }> = await cf("/d1/database?name=dream-ops")
  const ops = databases.find((db) => db.name === "dream-ops")
  if (!ops) throw new Error("No D1 dream-ops: run `node infra/scripts/dev-login.ts ensure`")
  const [result] = await cf(`/d1/database/${ops.uuid}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT value FROM settings WHERE name = 'DEV_LOGIN_SECRET'" })
  })
  const value = result?.results?.[0]?.value
  if (typeof value !== "string") throw new Error("DEV_LOGIN_SECRET isn't in dream-ops yet")
  return value
}

/**
 * Runs on the Mac (Node from Homebrew), fed on stdin. Fetches the key from the Worker (see the header), checks
 * it, writes it 0600, and signs one read-only App Store Connect call with it. Prints one JSON line of facts.
 */
const fetchKeyOnMac = String.raw`
const fs = require("node:fs"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process")
const [keyId, issuerId, bundleId, keyApi, instanceId] = process.argv.slice(2)
const subtle = crypto.webcrypto.subtle
const dir = process.env.HOME + "/.dream-asc", out = dir + "/AuthKey_" + keyId + ".p8"
const report = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1) }
const b64u = (bytes) => Buffer.from(bytes).toString("base64url")
;(async () => {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey))
  const audience = "dream-testflight:" + b64u(await subtle.digest("SHA-256", raw))
  let idToken
  try {
    idToken = JSON.parse(execFileSync("/opt/nsc/bin/nsc",
      ["auth", "issue-id-token", "--audience", audience, "--duration", "5m", "-o", "json"],
      { env: { ...process.env, NSC_TOKEN_FILE: "/var/run/nsc/token.json" }, stdio: ["ignore", "pipe", "pipe"] })).id_token
  } catch { report({ ok: false, problem: "nsc couldn't issue an ID token" }) }
  const r = await fetch(keyApi + "/testflight/asc-key", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken, publicKey: b64u(raw) }) })
  if (!r.ok) report({ ok: false, problem: "the Worker refused the key (" + r.status + "); its log says why" })
  const sealed = await r.json()
  const server = Buffer.from(sealed.serverPublicKey, "base64url")
  const serverKey = await subtle.importKey("raw", server, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, pair.privateKey, 256)
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
  const aes = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: Buffer.concat([raw, server]),
    info: Buffer.from("dream-testflight-asc-key/v1") }, hkdf, { name: "AES-GCM", length: 256 }, false, ["decrypt"])
  let pem
  try {
    pem = Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.iv, "base64url"),
      additionalData: Buffer.from(instanceId) }, aes, Buffer.from(sealed.ciphertext, "base64url"))).toString("utf8")
  } catch { report({ ok: false, problem: "couldn't decrypt what the Worker sent" }) }
  const facts = { bytes: pem.length, sha256: crypto.createHash("sha256").update(pem).digest("hex").slice(0, 12) }
  // Pasted into the dashboard, the .p8's line breaks may have become spaces; rebuild the PEM.
  const m = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/)
  if (!m) report({ ok: false, ...facts, problem: "ASC_TESTFLIGHT_KEY_P8 isn't a .p8 (no BEGIN/END PRIVATE KEY)" })
  const body = m[1].replace(/\s+/g, "")
  pem = "-----BEGIN PRIVATE KEY-----\n" + (body.match(/.{1,64}/g) || []).join("\n") + "\n-----END PRIVATE KEY-----\n"
  let key
  try { key = crypto.createPrivateKey(pem) } catch { report({ ok: false, ...facts, problem: "the .p8 doesn't parse" }) }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    report({ ok: false, ...facts, problem: "not an App Store Connect key (P-256)" })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  fs.writeFileSync(out, pem, { mode: 0o600 })
  fs.chmodSync(out, 0o600)
  Object.assign(facts, { mode: (fs.statSync(out).mode & 0o777).toString(8), dirMode: (fs.statSync(dir).mode & 0o777).toString(8) })
  const seg = (o) => b64u(Buffer.from(JSON.stringify(o)))
  const now = Math.floor(Date.now() / 1000)
  const unsigned = seg({ alg: "ES256", kid: keyId, typ: "JWT" }) + "." + seg({ iss: issuerId, iat: now, exp: now + 300, aud: "appstoreconnect-v1" })
  const jwt = unsigned + "." + b64u(crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }))
  const asc = await fetch("https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=" + bundleId + "&fields[apps]=name,bundleId",
    { headers: { authorization: "Bearer " + jwt } }).catch((e) => report({ ok: false, ...facts, problem: "App Store Connect unreachable: " + e.message }))
  const j = await asc.json().catch(() => ({}))
  const app = j.data?.[0]?.attributes
  report({ ok: asc.ok && !!app, ...facts, path: out, appStoreConnect: asc.status, app: app?.name,
    problem: asc.ok ? (app ? undefined : "no app record for " + bundleId)
      : "App Store Connect refused it (" + asc.status + "): " + (j.errors?.[0]?.detail ?? "") })
})().catch((e) => report({ ok: false, problem: e.message }))
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

  const keyDir = "$HOME/.dream-asc"
  const secret = await devSecret()
  const deadline = new Date(Date.now() + (mode === "check" ? 20 : 120) * 60_000).toISOString()
  log("Starting a Mac (macos.version=27.x)")
  const createMac = () =>
    compute("CreateInstance", {
      shape: {
        virtualCpu: 6,
        memoryMegabytes: 14336,
        os: "macos",
        machineArch: "arm64",
        selectors: [{ name: "macos.version", value: "27.x" }]
      },
      documentedPurpose: "Dream: TestFlight build of the iPhone app",
      labels: [{ name: "dream", value: "testflight" }],
      deadline
    })
  // A Mac destroyed a moment ago still holds the plan's one slot for about half a minute.
  let created: Json
  for (let attempt = 1; ; attempt++) {
    try {
      created = await createMac()
      break
    } catch (e: any) {
      if (!String(e.message).includes("instance limit")) throw e
      if (attempt >= 5)
        throw new Error(`${e.message}\nAnother Mac is running (one at a time on this plan); stop it first.`)
      await sleep(15_000)
    }
  }
  instanceId = created.metadata.instanceId as string
  log(`Mac ${instanceId} created; waiting for it to run`)

  for (let i = 0; ; i++) {
    const described = await compute("DescribeInstance", { instanceId })
    const status: string = described.metadata?.status ?? "UNKNOWN"
    if (status === "RUNNING") break
    if (status !== "PENDING" || i >= 60)
      throw new Error(status === "PENDING" ? "The Mac stayed PENDING for 5 minutes" : `The Mac ended up ${status}`)
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

  const granted = await fetch(`${keyApi}/admin/testflight/grants`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dream-dev-secret": secret },
    body: JSON.stringify({ instanceId })
  })
  if (!granted.ok) throw new Error(`Granting the Mac failed: ${granted.status} ${await granted.text()}`)
  log(`Granted Mac ${instanceId} the key (once, 15 minutes); fetching it on the Mac`)
  const fetched = await onMac(
    `PATH=/opt/homebrew/bin:$PATH node --input-type=commonjs - ${keyId} ${issuerId} ${bundleId} ${keyApi} ${instanceId}`,
    fetchKeyOnMac
  )
  const report: Json = JSON.parse(fetched.stdout.trim().split("\n").pop() || "{}")
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
