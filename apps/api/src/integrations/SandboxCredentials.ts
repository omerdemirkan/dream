/**
 * What a project's sandbox gets so the agent can use a person's credentials
 * without holding them: E2B egress rules carrying the real header values.
 * dreamd configures the harnesses with placeholders; the agent's own code
 * uses the placeholders named in each `AccessConnected` event.
 */
import { type Harness, IntegrationAccess, ModelEgress, type UserId } from "@dream/domain"
import { Effect, Context, Layer, Option } from "effect"
import { idTokenClaims } from "../connect/ChatGpt.ts"
import { Connections } from "../db/Connections.ts"
import type { NetworkRules } from "../e2b/E2B.ts"
import { toHex, utf8 } from "../lib/Bytes.ts"
import { CredentialStore } from "./CredentialStore.ts"
import { ProjectDirectory } from "../project/Client.ts"
import { headersFor, OAuthProviders } from "./OAuth.ts"

export const AppStoreConnectHost = "api.appstoreconnect.apple.com"

export interface SandboxSetup {
  readonly rules: NetworkRules
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
    readonly setup: (userId: UserId, harness: Harness) => Effect.Effect<SandboxSetup>
  }
>()("@dream/api/SandboxCredentials") {
  static readonly layer = Layer.effect(
    SandboxCredentials,
    Effect.gen(function* () {
      const connections = yield* Connections
      const store = yield* CredentialStore
      const providers = yield* OAuthProviders
      const directory = yield* ProjectDirectory

      const setup = Effect.fn("SandboxCredentials.setup")(function* (userId: UserId, harness: Harness) {
        const rules: Record<string, ReturnType<typeof header>> = {}

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
              ),
            // Written into its project's sandbox as a file (SandboxManager), never sent in a header.
            File: () => Effect.void,
            OAuth: (access) =>
              store.oauth(row).pipe(
                Effect.map((credential) => {
                  // A provider dropped from the catalog keeps working on the hosts it was connected with.
                  const spec = Option.getOrElse(providers.spec(access.provider), () => ({
                    hosts: access.hosts.map((host) => ({ host }))
                  }))
                  for (const [host, name, value] of headersFor(spec, credential.accessToken))
                    rules[host] = header({ [name]: value })
                }),
                Effect.catchTag("ConnectionLapsed", ({ userId, integration, failure }) =>
                  // Told apart from this delivery: this project's own DO may be the one asking.
                  directory.integrationGone(userId, integration, failure).pipe(Effect.forkDetach, Effect.asVoid)
                ),
                Effect.catch((error) => Effect.logWarning(`${access.service} credential unavailable`, error.message))
              )
          })
        }

        // The model credential, on the host dreamd points the harness at (ModelEgress).
        const egress = ModelEgress[harness]
        if (harness === "claude-code") {
          const connection = yield* connections.connectedModel(userId, "claude")
          if (Option.isSome(connection)) {
            const credential = yield* store.claude(connection.value)
            rules[egress.host] = header(ModelEgress["claude-code"].headers({ oauthToken: credential.token }))
          }
        } else {
          const connection = yield* connections.connectedModel(userId, "chatgpt")
          if (Option.isSome(connection)) {
            const credential = yield* store.chatGpt(connection.value).pipe(Effect.option)
            if (Option.isSome(credential)) {
              const accountId =
                credential.value.accountId ?? (yield* idTokenClaims(credential.value.idToken)).accountId ?? ""
              rules[egress.host] = header(
                ModelEgress.codex.headers({ accessToken: credential.value.accessToken, accountId })
              )
            }
          }
        }

        return { rules, rulesHash: yield* hashRules(rules) }
      })

      return SandboxCredentials.of({ setup })
    })
  )
}
