/**
 * DEV_LOGIN_SECRET: the shared secret behind `DevSignIn`, for development and
 * end-to-end tests before Google sign-in is configured.
 *
 * The value lives in two places, kept equal by `ensure`: the Worker secret the
 * API checks, and the `settings` table of a small D1 database, `dream-ops`,
 * so any thread with the workspace's Cloudflare connection can read it without
 * it ever landing in git. Reading it:
 *
 *   node infra/scripts/dev-login.ts ensure            # create it once (idempotent)
 *   node infra/scripts/dev-login.ts session <email>   # sign in on the deployed API; prints a session token
 *
 * or directly: POST /accounts/<account>/d1/database/<dream-ops id>/query
 *   {"sql":"SELECT value FROM settings WHERE name = 'DEV_LOGIN_SECRET'"}
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { ensureOpsSecret, readOpsSecret } from "./ops.ts"

const ApiUrl = process.env.DREAM_API_URL ?? `https://dream.${process.env.DREAM_DOMAIN ?? "omer.build"}`

export const readSecret = readOpsSecret("DEV_LOGIN_SECRET")

const ensure = ensureOpsSecret("DEV_LOGIN_SECRET")

const session = (email: string) =>
  Effect.gen(function* () {
    const secret = yield* readSecret
    if (secret === undefined) return yield* Console.error("No DEV_LOGIN_SECRET yet; run `ensure` first.")
    // One RPC request as NDJSON, the way an RpcClient sends it.
    const body = `${JSON.stringify({ _tag: "Request", id: "1", tag: "DevSignIn", payload: { email, secret }, headers: [] })}\n`
    const response = yield* Effect.promise(() =>
      fetch(`${ApiUrl}/rpc`, { method: "POST", headers: { "content-type": "application/ndjson" }, body }).then((r) =>
        r.text()
      )
    )
    const exit = response
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .find((message) => message._tag === "Exit")
    if (exit?.exit?._tag !== "Success") return yield* Console.error(`Sign-in failed: ${response}`)
    yield* Console.log(exit.exit.value.sessionToken)
  })

const [command, arg] = process.argv.slice(2)
const program =
  command === "ensure"
    ? ensure
    : command === "session" && arg !== undefined
      ? session(arg)
      : Console.error("Usage: node infra/scripts/dev-login.ts ensure | session <email>")

program.pipe(NodeRuntime.runMain)
