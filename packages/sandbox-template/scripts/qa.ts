/**
 * QA driver for end-to-end runs against the deployed Dream API, acting as the person in the app.
 * Run from the workspace root with Node 24 (fetch goes through the workspace's Cloudflare and E2B connections):
 *
 *   node packages/sandbox-template/scripts/qa.ts <command> [args]
 *
 *   projects                              list projects (title, phase, headline, url, open asks)
 *   idea "<text>"                         create a project from an idea; prints its id
 *   say <projectId> "<text>"              send a chat message
 *   msgs <projectId> [n]                  print the last n chat messages (default 20), oldest first
 *   asks                                  open questions and access requests across projects
 *   choose <projectId> <messageId> "<option>"     answer a question with one of its options
 *   reply <projectId> <messageId> "<text>"        answer a question in your own words
 *   decline <projectId> <messageId>       decline an access request
 *   sandbox <projectId>                   the project's E2B sandbox id and state
 *   logs <projectId> [lines]              tail dreamd's log in the project's sandbox (default 80)
 *   exec <projectId> "<shell command>"    run a command in the project's sandbox and print its output
 *   wait <projectId> [minutes]            wait until the agent is idle (no turn running) and print new messages
 *
 * The session is a dev sign-in as QA_EMAIL (default the founder's invited email), minted on demand.
 * It never prints secrets; the agent's sandbox holds only placeholders anyway.
 */
import { Sandbox } from "e2b"

const Api = process.env.DREAM_API_URL ?? "https://dream.omer.build"
const Account = "2d98de7c4511e98d2f774c4fcc9b9b93"
const Email = process.env.QA_EMAIL ?? "omerfarukpiano@gmail.com"
const Proxy = process.env.HTTPS_PROXY
process.env.E2B_API_KEY ??= "e2b_placeholder_injected_by_proxy"

type Json = any

const cf = async (path: string, init?: RequestInit): Promise<Json> => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${Account}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  })
  const body = await res.json()
  if (!body.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(body.errors)}`)
  return body.result
}

let rpcId = 0
const rpcRaw = async (tag: string, payload: unknown, token?: string): Promise<Json> => {
  const res = await fetch(`${Api}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/ndjson", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: `${JSON.stringify({ _tag: "Request", id: String(++rpcId), tag, payload, headers: [] })}\n`
  })
  const text = (await res.text()).trim()
  const last = text.split("\n").filter(Boolean).pop() ?? ""
  const msg = JSON.parse(last)
  if (msg.exit?._tag === "Success") return msg.exit.value
  throw new Error(`${tag} failed: ${JSON.stringify(msg.exit?.cause ?? msg).slice(0, 600)}`)
}

let token: string | undefined
const session = async (): Promise<string> => {
  if (token) return token
  if (process.env.DREAM_SESSION) return (token = process.env.DREAM_SESSION.trim())
  const dbs: Array<{ uuid: string; name: string }> = await cf("/d1/database")
  const ops = dbs.find((d) => d.name === "dream-ops")
  if (!ops) throw new Error("dream-ops database not found")
  const rows = await cf(`/d1/database/${ops.uuid}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT value FROM settings WHERE name = 'DEV_LOGIN_SECRET'" })
  })
  const secret = rows?.[0]?.results?.[0]?.value
  const signedIn = await rpcRaw("DevSignIn", { email: Email, secret })
  return (token = signedIn.sessionToken)
}
const rpc = async (tag: string, payload: unknown = null) => rpcRaw(tag, payload, await session())

const text = (m: Json): string => {
  switch (m._tag) {
    case "Text":
      return `${m.body ?? m.text ?? ""}${m.media?.length ? ` [media ×${m.media.length}]` : ""}`
    case "Question":
      return `QUESTION ${m.title ?? m.question ?? ""}${m.why ? ` (why: ${m.why})` : ""} options=${JSON.stringify(m.options ?? [])} state=${m.state?._tag}${m.state?.answer ? ` answer=${JSON.stringify(m.state.answer)}` : ""}`
    case "Access":
      return `ACCESS ${JSON.stringify(m.request ?? m.kind ?? {})} ${m.title ?? m.why ?? ""} state=${m.state?._tag}`
    default:
      return JSON.stringify(m).slice(0, 400)
  }
}
const printMessages = (ms: Json[]) => {
  for (const m of ms) {
    const who = m.author ?? m.from ?? m.sender ?? "?"
    const at = String(m.createdAt ?? m.sentAt ?? "").slice(11, 19)
    console.log(`${at} [${who}] ${m.id} ${text(m)}`)
  }
}

const findSandbox = async (projectId: string) => {
  const list = await Sandbox.list({ proxy: Proxy, query: { metadata: { projectId } } } as never)
  const items = typeof (list as Json).nextItems === "function" ? await (list as Json).nextItems() : (list as Json)
  const found = (items as Json[]).find((s) => s.metadata?.projectId === projectId)
  if (!found) throw new Error(`no sandbox for ${projectId}`)
  return found as { sandboxId: string; state: string }
}
const inSandbox = async (projectId: string, command: string, timeoutMs = 60_000) => {
  const { sandboxId } = await findSandbox(projectId)
  const sbx = await Sandbox.connect(sandboxId, { proxy: Proxy } as never)
  try {
    const r = await sbx.commands.run(command, { timeoutMs })
    return `${r.stdout}${r.stderr}`
  } catch (e: any) {
    return `exit ${e?.result?.exitCode ?? "?"}\n${e?.result?.stdout ?? ""}${e?.result?.stderr ?? ""}${e?.message ?? ""}`
  }
}

const [cmd, a, b, c] = process.argv.slice(2)
const main = async () => {
  switch (cmd) {
    case "projects": {
      for (const s of await rpc("ListProjects")) {
        const p = s.project
        console.log(
          `${p.id}  ${p.phase}  "${p.title}" (${p.kind ?? "?"})  ${p.headline ?? ""}  ${p.publicUrl ?? ""}  asks=${s.openAsks}`
        )
      }
      return
    }
    case "idea": {
      const p = await rpc("CreateProject", { idea: a })
      return console.log(p.id, p.publicUrl ?? "")
    }
    case "say":
      return console.log((await rpc("SendMessage", { projectId: a, text: b })).id)
    case "msgs": {
      const r = await rpc("ListMessages", { projectId: a, limit: Number(b ?? 20) })
      return printMessages([...r.messages].reverse())
    }
    case "asks": {
      for (const ask of await rpc("ListOpenAsks")) console.log(JSON.stringify(ask).slice(0, 500))
      return
    }
    case "choose":
      return console.log(
        text(await rpc("AnswerQuestion", { projectId: a, messageId: b, answer: { _tag: "Choice", option: c } }))
      )
    case "reply":
      return console.log(
        text(await rpc("AnswerQuestion", { projectId: a, messageId: b, answer: { _tag: "Freeform", text: c } }))
      )
    case "decline":
      return console.log(text(await rpc("DeclineAccess", { projectId: a, messageId: b })))
    case "sandbox":
      return console.log(JSON.stringify(await findSandbox(a)))
    case "logs":
      return console.log(await inSandbox(a, `tail -n ${Number(b ?? 80)} /home/user/.dream/logs/dreamd.log`))
    case "exec":
      return console.log(await inSandbox(a, b, 300_000))
    case "wait": {
      const deadline = Date.now() + Number(b ?? 15) * 60_000
      const before = new Set(
        ((await rpc("ListMessages", { projectId: a, limit: 50 })).messages as Json[]).map((m) => m.id)
      )
      let idleChecks = 0
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20_000))
        const log = await inSandbox(a, "tail -n 5 /home/user/.dream/logs/dreamd.log").catch(() => "")
        const lastStart = log.lastIndexOf("Turn started")
        const lastEnd = Math.max(log.lastIndexOf("Turn finished"), log.lastIndexOf("Turn failed"))
        idleChecks = lastEnd > lastStart || lastStart === -1 ? idleChecks + 1 : 0
        if (idleChecks >= 2) break
      }
      const after = ((await rpc("ListMessages", { projectId: a, limit: 50 })).messages as Json[]).reverse()
      printMessages(after.filter((m) => !before.has(m.id)))
      return
    }
    default:
      console.log("see the header of packages/sandbox-template/scripts/qa.ts")
  }
}
main().catch((e: any) => {
  console.error(String(e?.message ?? e))
  process.exit(1)
})
