/**
 * What a project's sandbox gets so the agent can use a person's credentials
 * without holding them: E2B egress rules carrying the real header values, and
 * placeholders (env vars, Codex's auth.json) for tools that insist on having
 * a credential configured.
 */
import { type Harness, IntegrationAccess, type ProjectId, type UserId } from "@dream/domain"
import { Effect, Context, Layer, Option } from "effect"
import { ApiConfig } from "../Config.ts"
import { Tokens } from "../auth/Tokens.ts"
import { ChatGptHosts, idTokenClaims, placeholderAuthFile } from "../connect/ChatGpt.ts"
import { Connections } from "../db/Connections.ts"
import type { NetworkRules } from "../e2b/E2B.ts"
import { toHex, utf8 } from "../lib/Bytes.ts"
import { CredentialStore } from "./CredentialStore.ts"

export const ClaudeTokenPlaceholder = "sk-ant-oat01-dream-placeholder"
export const AppStoreConnectHost = "api.appstoreconnect.apple.com"
export const CodexAuthPath = "/home/user/.codex/auth.json"

export interface SandboxSetup {
  readonly rules: NetworkRules
  /** Set when the sandbox is created (E2B envVars). */
  readonly envVars: Readonly<Record<string, string>>
  /** Written into the sandbox after it's created, and again when they change. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>
  /** Hash of `rules`, to skip pushing unchanged rules. */
  readonly rulesHash: string
}

const header = (headers: Record<string, string>) => [{ transform: { headers } }]

export const hashRules = (rules: NetworkRules): Effect.Effect<string> =>
  Effect.promise(async () => {
    const canonical = JSON.stringify(
      Object.keys(rules)
        .sort()
        .map((host) => [host, rules[host]])
    )
    return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(canonical))))
  })

export class SandboxCredentials extends Context.Service<
  SandboxCredentials,
  {
    readonly setup: (userId: UserId, projectId: ProjectId, harness: Harness) => Effect.Effect<SandboxSetup>
  }
>()("@dream/api/SandboxCredentials") {
  static readonly layer = Layer.effect(
    SandboxCredentials,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const connections = yield* Connections
      const store = yield* CredentialStore
      const tokens = yield* Tokens

      const setup = Effect.fn("SandboxCredentials.setup")(function* (
        userId: UserId,
        projectId: ProjectId,
        harness: Harness
      ) {
        const rules: Record<string, ReturnType<typeof header>> = {}
        const envVars: Record<string, string> = {}
        const files: Array<{ path: string; content: string }> = []

        // Integrations first, so the model's own hosts win any overlap.
        for (const row of yield* connections.integrations(userId)) {
          if (row.status !== "connected") continue
          yield* IntegrationAccess.match(row.access_json, {
            Google: (access) =>
              store.google(row).pipe(
                Effect.map((credential) => {
                  for (const host of access.hosts)
                    rules[host] = header({ Authorization: `Bearer ${credential.accessToken}` })
                }),
                Effect.catch((error) => Effect.logWarning("Google credential unavailable", error.message))
              ),
            Key: (access) =>
              store.apiKey(row).pipe(
                Effect.map((credential) => {
                  rules[access.host] = header({ [access.header]: access.format.replaceAll("{key}", credential.key) })
                })
              ),
            Apple: () =>
              store.apple(row).pipe(
                Effect.map((credential) => {
                  if (credential.jwt !== undefined)
                    rules[AppStoreConnectHost] = header({ Authorization: `Bearer ${credential.jwt}` })
                }),
                Effect.catch((error) => Effect.logWarning("App Store Connect credential unavailable", error.message))
              )
          })
        }

        if (harness === "claude-code") {
          envVars.CLAUDE_CODE_OAUTH_TOKEN = ClaudeTokenPlaceholder
          const connection = yield* connections.connectedModel(userId, "claude")
          if (Option.isSome(connection)) {
            const credential = yield* store.claude(connection.value)
            rules["api.anthropic.com"] = header({ Authorization: `Bearer ${credential.token}` })
          }
        } else {
          envVars.CODEX_REFRESH_TOKEN_URL_OVERRIDE = `${config.apiUrl}/sandbox/codex/token`
          const connection = yield* connections.connectedModel(userId, "chatgpt")
          if (Option.isSome(connection)) {
            const credential = yield* store.chatGpt(connection.value).pipe(Effect.option)
            if (Option.isSome(credential)) {
              const headers: Record<string, string> = { Authorization: `Bearer ${credential.value.accessToken}` }
              for (const host of ChatGptHosts) rules[host] = header(headers)
              const claims = yield* idTokenClaims(credential.value.idToken)
              const refreshToken = yield* tokens.codexRefresh(projectId, userId)
              files.push({
                path: CodexAuthPath,
                content: placeholderAuthFile(
                  { ...claims, accountId: credential.value.accountId ?? claims.accountId },
                  refreshToken
                )
              })
            }
          }
        }

        return { rules, envVars, files, rulesHash: yield* hashRules(rules) }
      })

      return SandboxCredentials.of({ setup })
    })
  )
}
