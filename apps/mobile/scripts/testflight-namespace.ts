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
 * Signing is manual, with Dream's one Apple Distribution certificate: the Worker releases it with the key (it
 * keeps the private key sealed), the first build Mac creates it through the App Store Connect API and stores it
 * (see setupSigningOnMac), and App Store profiles need no devices. Automatic signing can't work here (no usable
 * keychain over SSH, no devices for development profiles) and would mint certificates; cloud signing needs an
 * Admin key.
 * The build runs detached on the Mac (its own session, log at ~/dream-build/build.log, exit code in
 * ~/dream-build/exit); the launcher starts it and follows it in short SSH calls, retried, and every Compute API,
 * Cloudflare and Worker call is retried on network failures, because this environment drops requests now and
 * then. When the build ends, its script deletes the key, and the launcher destroys the Mac.
 * If the launcher dies (or is stopped) after the build started, the Mac keeps building: rerun `testflight` and
 * it finds the Mac by its label (dream=testflight) and picks it up instead of starting a second one. Before
 * that point, a failure or Ctrl-C destroys the Mac. The Mac's 2-hour deadline is the backstop.
 *
 *   node apps/mobile/scripts/testflight-namespace.ts destroy
 *       Destroys every build Mac (label dream=testflight).
 *
 * --dry-run (with testflight) does everything except the build, which becomes a 3-minute loop that reports
 * whether the key is in place; it exercises the key release, shipping, the detached run and the pick-up.
 *
 * Environment:
 *   DREAM_ASC_KEY_ID          default 5G566N355S
 *   DREAM_ASC_ISSUER_ID       default 0e7009f1-c7f0-40f0-b12e-b76df2001875
 *   DREAM_KEY_API_URL         the Worker that releases the key (default DREAM_API_URL, else https://dream.omer.build)
 *   DREAM_IDENTITY_API_URL    where a newly created signing identity is stored (default DREAM_KEY_API_URL)
 *   DREAM_DEV_SECRET          the operator secret for the grant; by default read from D1 `dream-ops` through the
 *                             Cloudflare API (the workspace's cloudflare-api connection, or CLOUDFLARE_API_TOKEN)
 *   NAMESPACE_TOKEN           bearer token for the Compute API; unset in an Outerloop workspace, where the
 *                             namespace-compute connection adds it
 *   NAMESPACE_API_URL         default https://us.compute.namespaceapis.com
 *   DREAM_APPLE_TEAM_ID, DREAM_BUNDLE_ID, DREAM_API_URL, DREAM_BACKEND, DREAM_GOOGLE_IOS_CLIENT_ID,
 *   DREAM_GOOGLE_WEB_CLIENT_ID, DREAM_APS_ENVIRONMENT, DREAM_UPDATES_CHANNEL, DREAM_UPDATES_URL,
 *   BUILD_NUMBER   passed to build-ios.sh (see there)
 *
 * It prints no secret: not the key, not the ID token, not the Mac's SSH key, not the App Store Connect token.
 * Never put one on an SSH command line: Namespace logs every SSH command run on the Mac.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mode = process.argv[2]
const noUpload = process.argv.includes("--no-upload")
const dryRun = process.argv.includes("--dry-run")
if (
  (mode !== "check" && mode !== "testflight" && mode !== "destroy") ||
  process.argv.slice(3).some((a) => a !== "--no-upload" && a !== "--dry-run")
) {
  console.error(
    "usage: node apps/mobile/scripts/testflight-namespace.ts check | testflight [--no-upload] [--dry-run] | destroy"
  )
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
const identityApi = (process.env.DREAM_IDENTITY_API_URL ?? keyApi).replace(/\/+$/, "")
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
  "DREAM_UPDATES_CHANNEL",
  "DREAM_UPDATES_URL",
  "BUILD_NUMBER"
]

type Json = any

const log = (line: string) => console.log(`› ${line}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * fetch, retried: this environment's network drops requests now and then ("fetch failed"), so network errors and
 * 5xx answers are retried with backoff for about two minutes. Callers that must not repeat a request (creating
 * a Mac) check first whether the earlier attempt went through.
 */
const fetchRetrying = async (url: string, init: RequestInit, what: string, tries = 8): Promise<Response> => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
      if (res.status < 500 || attempt >= tries) return res
      log(`${what}: ${res.status}, retrying`)
    } catch (e: any) {
      if (attempt >= tries) throw new Error(`${what}: ${e?.cause?.code ?? e?.message ?? e}`)
      if (attempt >= 2) log(`${what}: ${e?.cause?.code ?? e?.message ?? e}, retrying`)
    }
    await sleep(Math.min(2_000 * 2 ** (attempt - 1), 30_000))
  }
}

/** A Compute API call. CreateInstance isn't retried here (a lost answer may hide a created Mac); see main. */
const compute = async (method: string, body: object): Promise<Json> => {
  const token = process.env.NAMESPACE_TOKEN
  const res = await fetchRetrying(
    `${api}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    },
    `Namespace ${method}`,
    method === "CreateInstance" ? 1 : 8
  )
  const json: Json = await res.json().catch(() => ({}))
  // Only the message: some responses (DescribeInstance, GetSSHConfig) carry the Mac's SSH key.
  if (!res.ok) throw new Error(`Namespace ${method}: ${res.status} ${json?.message ?? ""}`)
  return json
}

/** The workspace's Dream build Macs (label dream=testflight) that aren't gone. */
const buildMacs = async (label?: { name: string; value: string }): Promise<Array<{ id: string; status: string }>> => {
  const macs: Array<{ id: string; status: string }> = []
  let cursor: string | undefined
  do {
    const page = await compute("ListInstances", cursor ? { paginationCursor: cursor } : {})
    for (const m of page.instances ?? []) {
      const labels: Array<{ name: string; value: string }> = m.labels ?? []
      const has = (l: { name: string; value: string }) => labels.some((x) => x.name === l.name && x.value === l.value)
      if (m.status !== "DESTROYED" && has({ name: "dream", value: "testflight" }) && (!label || has(label)))
        macs.push({ id: m.instanceId, status: m.status })
    }
    cursor = page.paginationCursor || undefined
  } while (cursor)
  return macs
}

/** DEV_LOGIN_SECRET, from the operator's D1 `dream-ops` (see infra/scripts/dev-login.ts). */
const devSecret = async (): Promise<string> => {
  if (process.env.DREAM_DEV_SECRET) return process.env.DREAM_DEV_SECRET
  const cf = async (path: string, init?: RequestInit): Promise<Json> => {
    const token = process.env.CLOUDFLARE_API_TOKEN
    const res = await fetchRetrying(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}${path}`,
      {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(token && token !== "anything" ? { authorization: `Bearer ${token}` } : {})
        }
      },
      "Cloudflare"
    )
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
  // The stored distribution signing identity, if the Worker has one (see setupSigningOnMac).
  if (sealed.identityIv && sealed.identityCiphertext) {
    try {
      const identity = Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.identityIv, "base64url"),
        additionalData: Buffer.from(instanceId + ":identity") }, aes, Buffer.from(sealed.identityCiphertext, "base64url")))
      fs.writeFileSync(dir + "/identity.json", identity, { mode: 0o600 })
      facts.identity = true
    } catch { report({ ok: false, problem: "couldn't decrypt the signing identity the Worker sent" }) }
  }
  Object.assign(facts, { mode: (fs.statSync(out).mode & 0o777).toString(8), dirMode: (fs.statSync(dir).mode & 0o777).toString(8) })
  const seg = (o) => b64u(Buffer.from(JSON.stringify(o)))
  const now = Math.floor(Date.now() / 1000)
  const unsigned = seg({ alg: "ES256", kid: keyId, typ: "JWT" }) + "." + seg({ iss: issuerId, iat: now, exp: now + 300, aud: "appstoreconnect-v1" })
  const jwt = unsigned + "." + b64u(crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }))
  const asc = await fetch("https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=" + bundleId + "&fields[apps]=name,bundleId",
    { headers: { authorization: "Bearer " + jwt } }).catch((e) => report({ ok: false, ...facts, problem: "App Store Connect unreachable: " + e.message }))
  const j = await asc.json().catch(() => ({}))
  const app = j.data?.[0]?.attributes
  // The latest uploads and whether testers can install them: processing, then each build's TestFlight state.
  if (asc.ok && app) {
    const b = await fetch("https://api.appstoreconnect.apple.com/v1/builds?filter[app]=" + j.data[0].id +
      "&sort=-uploadedDate&limit=4&fields[builds]=version,processingState,expired,uploadedDate,buildBetaDetail" +
      "&include=buildBetaDetail&fields[buildBetaDetails]=internalBuildState,externalBuildState",
      { headers: { authorization: "Bearer " + jwt } }).then((r) => r.json()).catch(() => ({}))
    // Builds anywhere on the account: an upload under another bundle id lands on another app. (Apple's upload records,
    // which say why an upload was rejected, can't be listed with this key; the reason goes to the account's email.)
    const all = await fetch("https://api.appstoreconnect.apple.com/v1/builds?sort=-uploadedDate&limit=4" +
      "&fields[builds]=version,processingState,uploadedDate,app&include=app&fields[apps]=bundleId",
      { headers: { authorization: "Bearer " + jwt } }).then((r) => r.json()).catch(() => ({}))
    facts.accountBuilds = (all.data ?? []).map((d) => d.attributes.version + " " + d.attributes.processingState + " " +
      ((all.included ?? []).find((a) => a.id === d.relationships?.app?.data?.id)?.attributes?.bundleId ?? "?"))
    const beta = new Map((b.included ?? []).map((d) => [d.id, d.attributes]))
    facts.builds = (b.data ?? []).map((d) => ({ build: d.attributes.version, uploaded: d.attributes.uploadedDate,
      processing: d.attributes.processingState, expired: d.attributes.expired,
      ...beta.get(d.relationships?.buildBetaDetail?.data?.id) }))
  }
  report({ ok: asc.ok && !!app, ...facts, path: out, appStoreConnect: asc.status, app: app?.name,
    problem: asc.ok ? (app ? undefined : "no app record for " + bundleId)
      : "App Store Connect refused it (" + asc.status + "): " + (j.errors?.[0]?.detail ?? "") })
})().catch((e) => report({ ok: false, problem: e.message }))
`

/**
 * Runs on the Mac after the key arrived, fed on stdin: sets up manual distribution signing that stays within
 * Apple's certificate limit. It reuses the one Apple Distribution certificate the Worker keeps (released with the
 * key into ~/.dream-asc/identity.json); if there is none yet, or it's gone or about to expire, it creates one
 * through the App Store Connect API from a key generated here and stores it with the Worker
 * (`/testflight/signing-identity`). It registers the bundle ids, creates or reuses App Store provisioning
 * profiles (no devices needed), and imports the identity into a temporary unlocked keychain, since an SSH session
 * has no usable login keychain. Writes ~/dream-build/signing.env for build-ios.sh. Prints one JSON line.
 */
const setupSigningOnMac = String.raw`
const fs = require("node:fs"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process")
const [keyId, issuerId, keyApi, teamId, appBundle, widgetBundle] = process.argv.slice(2)
const identityApi = process.argv[8] || keyApi
const home = process.env.HOME, dir = home + "/.dream-asc", buildDir = home + "/dream-build"
const report = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1) }
const b64u = (b) => Buffer.from(b).toString("base64url")
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString()
const ascKey = crypto.createPrivateKey(fs.readFileSync(dir + "/AuthKey_" + keyId + ".p8"))
const jwt = () => {
  const now = Math.floor(Date.now() / 1000), seg = (o) => b64u(JSON.stringify(o))
  const u = seg({ alg: "ES256", kid: keyId, typ: "JWT" }) + "." + seg({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })
  return u + "." + b64u(crypto.sign("sha256", Buffer.from(u), { key: ascKey, dsaEncoding: "ieee-p1363" }))
}
const asc = async (method, path, body) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch("https://api.appstoreconnect.apple.com" + path, { method,
        headers: { authorization: "Bearer " + jwt(), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined })
      if (r.status >= 500 && attempt < 4) continue
      const json = r.status === 204 ? {} : await r.json().catch(() => ({}))
      return { status: r.status, body: json, detail: json.errors?.[0]?.detail ?? "" }
    } catch (e) { if (attempt >= 4) throw e }
  }
}
;(async () => {
  // 1. The distribution certificate: reuse the stored one while App Store Connect still has it.
  let identity = fs.existsSync(dir + "/identity.json") ? JSON.parse(fs.readFileSync(dir + "/identity.json", "utf8")) : undefined
  let created = false
  if (identity) {
    const r = await asc("GET", "/v1/certificates/" + identity.certificateId + "?fields[certificates]=certificateType,expirationDate")
    const expires = r.body.data?.attributes?.expirationDate
    if (r.status !== 200 || !expires || Date.parse(expires) < Date.now() + 14 * 86400e3) identity = undefined
  }
  if (!identity) {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    const keyPem = privateKey.export({ type: "pkcs8", format: "pem" })
    fs.writeFileSync(dir + "/dist.key", keyPem, { mode: 0o600 })
    const csr = sh("/usr/bin/openssl", ["req", "-new", "-key", dir + "/dist.key", "-subj", "/CN=Dream TestFlight/O=" + teamId])
    const csrContent = csr.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")
    const r = await asc("POST", "/v1/certificates", { data: { type: "certificates", attributes: { certificateType: "DISTRIBUTION", csrContent } } })
    if (r.status !== 201) report({ ok: false, problem: "creating the Apple Distribution certificate failed (" + r.status + "): " + r.detail })
    identity = { certificateId: r.body.data.id, certificate: r.body.data.attributes.certificateContent, privateKey: keyPem }
    created = true
    // Also here, so a rerun of this step on this Mac (a picked-up build) reuses it instead of creating another.
    fs.writeFileSync(dir + "/identity.json", JSON.stringify(identity), { mode: 0o600 })
    // Keep it with the Worker for the next builds; without that it would be one more certificate per build.
    const digest = crypto.createHash("sha256").update(identity.certificateId + "\n" + identity.certificate + "\n" + identity.privateKey).digest()
    let stored = false
    try {
      const idToken = JSON.parse(execFileSync("/opt/nsc/bin/nsc",
        ["auth", "issue-id-token", "--audience", "dream-testflight-identity:" + b64u(digest), "--duration", "5m", "-o", "json"],
        { env: { ...process.env, NSC_TOKEN_FILE: "/var/run/nsc/token.json" }, stdio: ["ignore", "pipe", "pipe"] })).id_token
      for (let attempt = 1; attempt <= 4 && !stored; attempt++) {
        const up = await fetch(identityApi + "/testflight/signing-identity", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken, identity }) }).catch(() => undefined)
        stored = !!up && up.ok
        if (up && up.status < 500 && !up.ok) break
      }
    } catch {}
    if (!stored) {
      fs.rmSync(dir + "/identity.json", { force: true })
      await asc("DELETE", "/v1/certificates/" + identity.certificateId)
      report({ ok: false, problem: "the Worker didn't store the new certificate, so it was revoked again" })
    }
  }
  // 2. Bundle ids (the widget's is registered on first use).
  const bundleId = async (identifier, name) => {
    const r = await asc("GET", "/v1/bundleIds?filter[identifier]=" + identifier + "&fields[bundleIds]=identifier&limit=50")
    const found = (r.body.data ?? []).find((b) => b.attributes.identifier === identifier)
    if (found) return found.id
    const c = await asc("POST", "/v1/bundleIds", { data: { type: "bundleIds", attributes: { identifier, name, platform: "IOS" } } })
    if (c.status !== 201) report({ ok: false, problem: "registering " + identifier + " failed (" + c.status + "): " + c.detail })
    return c.body.data.id
  }
  // 3. App Store profiles for the certificate, reused while valid.
  const profilesDirs = [home + "/Library/MobileDevice/Provisioning Profiles", home + "/Library/Developer/Xcode/UserData/Provisioning Profiles"]
  const profile = async (identifier, name) => {
    const id = await bundleId(identifier, name)
    const profileName = "Dream TestFlight " + identifier
    const r = await asc("GET", "/v1/profiles?filter[name]=" + encodeURIComponent(profileName) + "&include=certificates&limit=20")
    const mine = (r.body.data ?? []).filter((p) => p.attributes.name === profileName)
    let p = mine.find((p) => p.attributes.profileState === "ACTIVE" && Date.parse(p.attributes.expirationDate) > Date.now() + 86400e3 &&
      (p.relationships?.certificates?.data ?? []).some((c) => c.id === identity.certificateId))
    if (!p) {
      for (const old of mine) await asc("DELETE", "/v1/profiles/" + old.id)
      const c = await asc("POST", "/v1/profiles", { data: { type: "profiles", attributes: { name: profileName, profileType: "IOS_APP_STORE" },
        relationships: { bundleId: { data: { type: "bundleIds", id } }, certificates: { data: [{ type: "certificates", id: identity.certificateId }] } } } })
      if (c.status !== 201) report({ ok: false, problem: "creating the profile for " + identifier + " failed (" + c.status + "): " + c.detail })
      p = c.body.data
    }
    for (const d of profilesDirs) {
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(d + "/" + p.attributes.uuid + ".mobileprovision", Buffer.from(p.attributes.profileContent, "base64"))
    }
    return profileName
  }
  const appProfile = await profile(appBundle, "Dream")
  const widgetProfile = await profile(widgetBundle, "Dream Widget")
  // 4. A temporary keychain holding only the identity, unlocked for the build.
  const kc = home + "/Library/Keychains/dream-build.keychain-db"
  const pw = crypto.randomBytes(24).toString("hex")
  try { sh("/usr/bin/security", ["delete-keychain", kc]) } catch {}
  sh("/usr/bin/security", ["create-keychain", "-p", pw, kc])
  sh("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", kc])
  sh("/usr/bin/security", ["unlock-keychain", "-p", pw, kc])
  fs.writeFileSync(dir + "/dist.key", identity.privateKey, { mode: 0o600 })
  fs.writeFileSync(dir + "/dist.cer", Buffer.from(identity.certificate, "base64"))
  sh("/usr/bin/openssl", ["x509", "-inform", "DER", "-in", dir + "/dist.cer", "-out", dir + "/dist.pem"])
  sh("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", dir + "/dist.key", "-in", dir + "/dist.pem", "-out", dir + "/dist.p12", "-passout", "pass:" + pw])
  sh("/usr/bin/security", ["import", dir + "/dist.p12", "-k", kc, "-P", pw, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"])
  for (const f of ["dist.key", "dist.p12", "dist.cer", "dist.pem"]) fs.rmSync(dir + "/" + f, { force: true })
  for (const ca of ["AppleWWDRCAG3.cer", "AppleWWDRCAG6.cer"]) {
    try {
      const r = await fetch("https://www.apple.com/certificateauthority/" + ca)
      if (r.ok) { fs.writeFileSync(buildDir + "/" + ca, Buffer.from(await r.arrayBuffer())); sh("/usr/bin/security", ["import", buildDir + "/" + ca, "-k", kc]) }
    } catch {}
  }
  sh("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", pw, kc])
  // An SSH session searches only the common and system keychain lists (not the user's), so the build adds the
  // keychain there and unlocks it again in its own session (run.sh); the password stays in ~/.dream-asc.
  sh("/usr/bin/security", ["list-keychains", "-d", "user", "-s", kc, home + "/Library/Keychains/login.keychain-db"])
  sh("/usr/bin/sudo", ["-n", "/usr/bin/security", "list-keychains", "-d", "common", "-s", kc, "/Library/Keychains/System.keychain"])
  fs.writeFileSync(dir + "/keychain.pw", pw, { mode: 0o600 })
  const found = sh("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning", kc])
  const name = (found.match(/"(Apple Distribution: [^"]+)"/) || [])[1]
  if (!name) report({ ok: false, problem: "the keychain has no valid signing identity: " + found.trim().split("\n").pop() })
  fs.writeFileSync(buildDir + "/signing.env", [
    "export ASC_SIGNING=manual",
    "export DREAM_SIGN_KEYCHAIN='" + kc + "'",
    "export DREAM_WIDGET_BUNDLE_ID='" + widgetBundle + "'",
    "export DREAM_PROFILE_APP='" + appProfile + "'",
    "export DREAM_PROFILE_WIDGET='" + widgetProfile + "'", ""].join("\n"))
  report({ ok: true, certificateId: identity.certificateId, created, identity: name, profiles: [appProfile, widgetProfile] })
})().catch((e) => report({ ok: false, problem: e.message }))
`

let instanceId: string | undefined
let workDir: string | undefined
/** Set once the build runs detached on the Mac: from then on only its outcome (or the deadline) ends the Mac. */
let detached = false

const destroy = async () => {
  if (instanceId) {
    const id = instanceId
    instanceId = undefined
    // Keep trying for about ten minutes: the network here can be gone for minutes, and a Mac left running costs.
    for (let attempt = 1; ; attempt++) {
      try {
        await compute("DestroyInstance", { instanceId: id })
        log(`Destroyed Mac ${id}`)
        break
      } catch (e: any) {
        if (attempt >= 4) {
          console.error(
            `Destroying Mac ${id} failed (${e.message}): run \`node apps/mobile/scripts/testflight-namespace.ts destroy\` (its deadline ends it otherwise)`
          )
          break
        }
        await sleep(30_000)
      }
    }
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
}
const leave = () => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  console.error(
    `The build keeps running on Mac ${instanceId}: rerun \`node apps/mobile/scripts/testflight-namespace.ts testflight\` to pick it up, or \`… destroy\` to stop it. Its deadline ends it otherwise.`
  )
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (detached) {
      leave()
      process.exit(130)
    }
    void destroy().finally(() => process.exit(130))
  })

const run = (command: string, args: Array<string>, input?: string | Buffer) =>
  new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] })
    let stdout = ""
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }))
    // A child that exits without reading its input (EPIPE) reports through its exit code.
    child.stdin.on("error", () => {})
    child.stdin.end(input ?? "")
  })

/** Where the detached build keeps its state on the Mac. */
const buildDir = "$HOME/dream-build"
const keyDir = "$HOME/.dream-asc"

/** Purpose strings the app's linked APIs need, or App Store Connect rejects the upload (ITMS-90683). */
const requiredPurposeStrings = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSPhotoLibraryUsageDescription",
  "NSSpeechRecognitionUsageDescription"
]

const main = async () => {
  if (mode === "destroy") {
    const macs = await buildMacs()
    for (const mac of macs) {
      instanceId = mac.id
      await destroy()
    }
    if (macs.length === 0) log("No build Mac is running")
    return
  }

  // Pick up a build Mac a previous run left (its launcher died), rather than start a second one.
  const existing = await buildMacs()
  if (existing.length > 1)
    throw new Error(`Several build Macs are running (${existing.map((m) => m.id).join(", ")}): run \`… destroy\``)
  if (existing.length === 1 && mode === "check")
    throw new Error(`Build Mac ${existing[0]!.id} is running: rerun \`testflight\` to pick it up, or \`destroy\` it`)
  if (existing.length === 1) {
    instanceId = existing[0]!.id
    detached = true // until its state says otherwise, don't end a Mac this run didn't start
    log(`Picking up build Mac ${instanceId} (${existing[0]!.status})`)
  } else {
    if (mode === "testflight") {
      // build-ios.sh refuses a TestFlight build that couldn't take over-the-air updates; say so before a Mac starts.
      const certificate = await run("git", ["ls-files", "--error-unmatch", "apps/mobile/certs/updates-certificate.pem"])
      if (certificate.code !== 0)
        throw new Error("No committed update signing certificate: run `node apps/mobile/scripts/updates.ts init` first")
      const dirty = await run("git", ["status", "--porcelain", "--untracked-files=no"])
      if (dirty.stdout.trim()) log("Uncommitted changes aren't shipped: the Mac builds HEAD")
      // App Store Connect rejects a build after upload, by email an hour later, when the binary links an API without
      // its purpose string (ITMS-90683): the picker links the camera and microphone, dictation the microphone and
      // speech recognition. A plugin option can also delete one another plugin set. Check the real Info.plist first.
      const introspect = await run("sh", [
        "-c",
        "cd apps/mobile && DREAM_APS_ENVIRONMENT=production npx expo config --type introspect --json"
      ])
      const plist = (JSON.parse(introspect.stdout || "{}") as Json).ios?.infoPlist ?? {}
      const missing = requiredPurposeStrings.filter((key) => typeof plist[key] !== "string" || plist[key].trim() === "")
      if (introspect.code !== 0 || missing.length > 0)
        throw new Error(
          `Info.plist lacks ${missing.join(", ") || "(couldn't read it)"}: App Store Connect would reject the build`
        )
      log(`Info.plist has its purpose strings (${requiredPurposeStrings.length})`)
    }
    const deadline = new Date(Date.now() + (mode === "check" ? 20 : 120) * 60_000).toISOString()
    // A run label, so a CreateInstance whose answer was lost can be found instead of repeated.
    const runLabel = {
      name: "dream-run",
      value: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    }
    log("Starting a Mac (macos.version=27.x)")
    for (let attempt = 1; ; attempt++) {
      try {
        const created = await compute("CreateInstance", {
          shape: {
            virtualCpu: 6,
            memoryMegabytes: 14336,
            os: "macos",
            machineArch: "arm64",
            selectors: [{ name: "macos.version", value: "27.x" }]
          },
          documentedPurpose: "Dream: TestFlight build of the iPhone app",
          labels: [{ name: "dream", value: "testflight" }, runLabel],
          deadline
        })
        instanceId = created.metadata.instanceId as string
        break
      } catch (e: any) {
        const found = await buildMacs(runLabel).catch(() => [])
        if (found.length > 0) {
          instanceId = found[0]!.id
          break
        }
        // Retry network failures, and the plan's one-Mac limit (a Mac destroyed a moment ago still holds the slot
        // for about half a minute); other refusals are final.
        const limit = String(e.message).includes("instance limit")
        if ((/CreateInstance: 4\d\d/.test(e.message) && !limit) || attempt >= 5)
          throw new Error(
            limit ? `${e.message}\nAnother Mac is running (one at a time on this plan); stop it first.` : e.message
          )
        log(`Creating the Mac: ${limit ? "the Mac slot is still taken" : e.message}; retrying`)
        await sleep(15_000)
      }
    }
    log(`Mac ${instanceId} created; waiting for it to run`)
  }

  for (let i = 0; ; i++) {
    const described = await compute("DescribeInstance", { instanceId })
    const status: string = described.metadata?.status ?? "UNKNOWN"
    if (status === "RUNNING") break
    if (status !== "PENDING" || i >= 60) {
      detached = false
      throw new Error(status === "PENDING" ? "The Mac stayed PENDING for 5 minutes" : `The Mac ended up ${status}`)
    }
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
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-o",
    "LogLevel=ERROR",
    `${ssh.username}@${ssh.endpoint}`
  ]
  /** One short SSH call, retried while the connection itself fails (exit 255). */
  const onMac = async (script: string, input?: string | Buffer, tries = 6) => {
    for (let attempt = 1; ; attempt++) {
      const result = await run("ssh", [...sshArgs, script], input)
      if (result.code !== 255 || attempt >= tries) return result
      await sleep(Math.min(3_000 * attempt, 20_000))
    }
  }

  const keyFile = `${keyDir}/AuthKey_${keyId}.p8`
  const state = (
    await onMac(
      `if [ -f ${buildDir}/exit ]; then echo done; elif [ -f ${buildDir}/pid ]; then echo started; elif [ -s ${keyFile} ]; then echo keyed; else echo fresh; fi`
    )
  ).stdout.trim()
  if (!["done", "started", "keyed", "fresh"].includes(state)) throw new Error("Can't reach the Mac over SSH")
  if (state === "fresh" || state === "keyed") detached = false

  if (state === "fresh") {
    const secret = await devSecret()
    const granted = await fetchRetrying(
      `${keyApi}/admin/testflight/grants`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-dream-dev-secret": secret },
        body: JSON.stringify({ instanceId })
      },
      "Granting the Mac"
    )
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
    for (const line of [...((report.accountBuilds as ReadonlyArray<string> | undefined) ?? [])]) log(`  ${line}`)
    for (const b of (report.builds as ReadonlyArray<Json> | undefined) ?? [])
      log(
        `  build ${b.build}, uploaded ${b.uploaded}: ${b.processing}${b.expired ? ", expired" : ""}; internal testing ${b.internalBuildState ?? "?"}, external ${b.externalBuildState ?? "?"}`
      )
  } else if (state === "keyed") log("The key is already on the Mac")

  if (mode === "check") {
    await onMac(`rm -rf ${keyDir}`)
    log("Deleted the key from the Mac")
    return
  }

  if (state === "fresh" || state === "keyed") {
    log("Setting up distribution signing on the Mac")
    const teamId = process.env.DREAM_APPLE_TEAM_ID ?? "ZY6RS9293V"
    const signing = await onMac(
      `mkdir -p ${buildDir} && PATH=/opt/homebrew/bin:$PATH node --input-type=commonjs - ${keyId} ${issuerId} ${keyApi} ${teamId} ${bundleId} ${bundleId}.widget ${identityApi}`,
      setupSigningOnMac
    )
    const signed: Json = JSON.parse(signing.stdout.trim().split("\n").pop() || "{}")
    if (!signed.ok) throw new Error(`Signing setup failed: ${signed.problem ?? "unknown"}`)
    log(
      `Signing with "${signed.identity}" (certificate ${signed.certificateId}, ${signed.created ? "created now and stored with the Worker" : "reused"}); profiles ${signed.profiles.join(", ")}`
    )

    log("Shipping HEAD to the Mac")
    const tarball = join(workDir, "dream.tar")
    const archived = await run("git", ["archive", "--format=tar", "-o", tarball, "HEAD"])
    if (archived.code !== 0) throw new Error("git archive failed")
    const bytes = readFileSync(tarball)
    const digest = createHash("sha256").update(bytes).digest("hex")
    for (let attempt = 1; ; attempt++) {
      await onMac(`mkdir -p ${buildDir} && cat > ${buildDir}/dream.tar`, bytes)
      const remote = await onMac(`shasum -a 256 ${buildDir}/dream.tar 2>/dev/null | cut -d' ' -f1`)
      if (remote.stdout.trim() === digest) break
      if (attempt >= 5) throw new Error("Shipping the tree failed")
      log("The upload came through incomplete; sending it again")
    }
    const env = passThrough
      .filter((name) => process.env[name] !== undefined)
      .map((name) => `${name}=${quote(process.env[name] ?? "")}`)
      .join(" ")
    // Runs detached; deletes the key itself when the build ends, so a dead launcher doesn't leave it behind.
    const script = [
      "#!/bin/bash",
      "set -uo pipefail",
      'export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"',
      `. "${buildDir}/signing.env"`,
      `/usr/bin/security unlock-keychain -p "$(cat "${keyDir}/keychain.pw")" "$DREAM_SIGN_KEYCHAIN"`,
      '/usr/bin/sudo -n /usr/bin/security list-keychains -d common -s "$DREAM_SIGN_KEYCHAIN" /Library/Keychains/System.keychain',
      `rm -rf "$HOME/dream" && mkdir "$HOME/dream" && tar -xf "${buildDir}/dream.tar" -C "$HOME/dream"`,
      "(",
      "  set -e",
      // SHELL=/bin/sh: the installer then leaves ~/.zshrc alone (its edits make every later SSH call noisy).
      "  command -v bun >/dev/null || curl -fsSL https://bun.sh/install | SHELL=/bin/sh bash -s bun-v1.4.4 >/dev/null 2>&1",
      '  cd "$HOME/dream"',
      dryRun
        ? `  for i in $(seq 1 18); do echo "dry run $i/18: key $([ -s "${keyFile}" ] && echo present || echo missing)"; sleep 10; done`
        : `  ${env} ${noUpload ? "ASC_EXPORT_ONLY=1 " : ""}apps/mobile/scripts/build-ios.sh testflight --asc-key-path "${keyFile}" --asc-key-id ${keyId} --asc-issuer-id ${issuerId}`,
      ")",
      "code=$?",
      `rm -rf "${keyDir}"`,
      '/usr/bin/security delete-keychain "$DREAM_SIGN_KEYCHAIN" 2>/dev/null',
      "/usr/bin/sudo -n /usr/bin/security list-keychains -d common -s /Library/Keychains/System.keychain",
      `echo $code > "${buildDir}/exit.tmp" && mv "${buildDir}/exit.tmp" "${buildDir}/exit"`,
      ""
    ].join("\n")
    await onMac(`cat > ${buildDir}/run.sh && chmod +x ${buildDir}/run.sh`, script)
    // Starting is the one step that mustn't repeat: the pid file makes a retried start a no-op.
    const started = await onMac(
      // Its own session (macOS has no setsid(1); its nohup refuses to run without a console), so it outlives SSH.
      `cd ${buildDir} && if [ ! -f pid ]; then echo ${digest.slice(0, 12)} > commit; /usr/bin/perl -MPOSIX=setsid -e 'setsid(); exec @ARGV' ./run.sh > build.log 2>&1 < /dev/null & echo $! > pid; fi; cat pid`
    )
    if (!started.stdout.trim()) throw new Error("Starting the build on the Mac failed")
    detached = true
    log(`Build started on the Mac (detached; log at ~/dream-build/build.log)`)
  } else if (state === "started") log("The build is already running; following it")

  // Follow the log in short SSH calls until the build writes its exit code. Picking up a running build starts
  // from the log's last 20 KB.
  let offset =
    state === "started"
      ? Math.max(0, Number((await onMac(`wc -c < ${buildDir}/build.log`)).stdout.trim() || 0) - 20_000)
      : 0
  let lastContact = Date.now()
  for (;;) {
    const poll = await onMac(
      `cd ${buildDir} 2>/dev/null || exit 3; size=$(wc -c < build.log | tr -d ' '); echo "@@$( [ -f exit ] && cat exit || { kill -0 $(cat pid) 2>/dev/null && echo running || echo died; } ) $size"; tail -c +$((${offset} + 1)) build.log | head -c 200000`,
      undefined,
      2
    )
    if (poll.code === 0 || poll.code === 3) {
      lastContact = Date.now()
      const [head, ...rest] = poll.stdout.split("\n")
      const m = /^@@(\S+) (\d+)/.exec(head ?? "")
      if (poll.code === 3 || !m) throw new Error("The Mac has no build state; destroy it with `… destroy` and rerun")
      const chunk = rest.join("\n")
      if (chunk) process.stdout.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`)
      offset += Buffer.byteLength(chunk)
      if (offset > Number(m[2])) offset = Number(m[2])
      if (m[1] !== "running") {
        // "died": the build process is gone without an exit code (killed, or the Mac rebooted).
        const code = m[1] === "died" ? -1 : Number(m[1])
        detached = false
        await onMac(`rm -rf ${keyDir}`)
        log("Deleted the key from the Mac")
        if (code !== 0)
          throw new Error(code === -1 ? "The build process died on the Mac" : `build-ios.sh failed (exit ${code})`)
        return
      }
    } else if (Date.now() - lastContact > 20 * 60_000) {
      throw new Error("Lost the Mac for 20 minutes")
    }
    await sleep(20_000)
  }
}

main()
  .then(destroy)
  .catch(async (e: Error) => {
    console.error(`✗ ${e.message}`)
    if (detached) leave()
    else await destroy()
    process.exit(1)
  })
