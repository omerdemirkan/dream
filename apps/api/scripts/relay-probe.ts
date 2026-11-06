/**
 * Bundles, deploys and deletes the throwaway relay probe Worker (`relay-probe/worker.ts`) on workers.dev, for an
 * end-to-end check of a relay in workerd. It never touches Dream's own Worker: the probe has its own name, its own
 * Durable Object class and no other bindings.
 *
 *   node apps/api/scripts/relay-probe.ts deploy <name>     bundle and upload (again: a redeploy), print its URL
 *   node apps/api/scripts/relay-probe.ts delete <name>
 *
 * deploy reads PROBE_KEY, DISCORD_BOT_TOKEN, DISCORD_API_URL and DISCORD_GATEWAY_HOST from the environment, and
 * CLOUDFLARE_ACCOUNT_ID (the API token is added on the way out by the workspace's connection, or CLOUDFLARE_API_TOKEN).
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const [command, name] = process.argv.slice(2)
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "2d98de7c4511e98d2f774c4fcc9b9b93"
const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers`
const headers: Record<string, string> =
  process.env.CLOUDFLARE_API_TOKEN === undefined ? {} : { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }

if (name === undefined || !/^[a-z0-9-]+-probe[a-z0-9-]*$/.test(name)) {
  console.error(
    "Name the probe something ending in -probe…, e.g. dream-relay-probe-1, so it can't clash with Dream's Worker."
  )
  process.exit(2)
}

const call = async (method: string, path: string, body?: BodyInit, contentType?: string) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...headers, ...(contentType === undefined ? {} : { "content-type": contentType }) },
    ...(body === undefined ? {} : { body })
  })
  const result = (await response.json()) as { success: boolean; errors: Array<{ message: string }>; result?: any }
  if (!result.success) throw new Error(`${method} ${path}: ${result.errors.map((error) => error.message).join("; ")}`)
  return result.result
}

const need = (variable: string) => {
  const value = process.env[variable]
  if (value === undefined || value.length === 0) throw new Error(`Set ${variable}.`)
  return value
}

const deploy = async () => {
  const out = join(process.env.TMPDIR ?? "/tmp", `${name}-bundle`)
  mkdirSync(out, { recursive: true })
  const entry = fileURLToPath(new URL("./relay-probe/worker.ts", import.meta.url))
  execFileSync(
    "bun",
    ["build", entry, "--target=browser", "--format=esm", `--outdir=${out}`, "--external", "cloudflare:workers"],
    { stdio: "inherit" }
  )
  const existing = await call("GET", "/scripts").then((scripts: Array<{ id: string }>) =>
    scripts.some((script) => script.id === name)
  )
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "durable_object_namespace", name: "RELAY", class_name: "RelayProbe" },
      { type: "secret_text", name: "PROBE_KEY", text: need("PROBE_KEY") },
      { type: "secret_text", name: "DISCORD_BOT_TOKEN", text: need("DISCORD_BOT_TOKEN") },
      { type: "plain_text", name: "DISCORD_API_URL", text: need("DISCORD_API_URL") },
      { type: "plain_text", name: "DISCORD_GATEWAY_HOST", text: need("DISCORD_GATEWAY_HOST") }
    ],
    ...(existing ? {} : { migrations: { new_tag: "v1", new_sqlite_classes: ["RelayProbe"] } })
  }
  const form = new FormData()
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }))
  form.append(
    "worker.js",
    new Blob([readFileSync(join(out, "worker.js"))], { type: "application/javascript+module" }),
    "worker.js"
  )
  await call("PUT", `/scripts/${name}`, form)
  await call("POST", `/scripts/${name}/subdomain`, JSON.stringify({ enabled: true }), "application/json")
  const subdomain = (await call("GET", "/subdomain")) as { subdomain: string }
  console.log(`${existing ? "Redeployed" : "Deployed"} https://${name}.${subdomain.subdomain}.workers.dev`)
}

const remove = async () => {
  await call("DELETE", `/scripts/${name}?force=true`)
  console.log(`Deleted ${name}`)
}

await (command === "deploy"
  ? deploy()
  : command === "delete"
    ? remove()
    : Promise.reject(new Error("deploy or delete")))
