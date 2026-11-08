/**
 * Renders the email `dream email` sends for a sample (an Apple Developer walkthrough), to look at in a browser:
 * `node apps/api/scripts/agent-email-preview.ts [file.md] [out-dir]` writes `agent-email.html` and `agent-email.txt`.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { agentEmail } from "../src/email/AgentEmail.ts"

const source = process.argv[2] ?? new URL("../test/fixtures-apple-walkthrough.md", import.meta.url).pathname
const out = process.argv[3] ?? "mocks/screens/agent-email"
const mail = agentEmail({
  to: "you@example.com",
  subject: "Set up Tide Clock in Apple Developer",
  markdown: readFileSync(source, "utf8"),
  project: "Tide Clock"
})
writeFileSync(join(out, "agent-email.html"), mail.html)
writeFileSync(join(out, "agent-email.txt"), `Subject: ${mail.subject}\n\n${mail.text}\n`)
console.log(`Wrote ${join(out, "agent-email.html")} and .txt`)
