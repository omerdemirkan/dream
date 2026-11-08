/**
 * What the harness processes (and so the agent's shell, and every app it
 * starts) see: this sandbox's environment without dreamd's tokens, plus the
 * placeholder model credential each harness needs. The real credential is
 * added at egress (`ModelEgress`); nothing here can refresh it.
 *
 * Dream's AI gateway (`OpenAIGateway`), while it's on, is for the agent's commands and apps, never a harness's own
 * model traffic: `commandEnv` carries its variables, and each harness passes them only to what it runs
 * (`sessionEnv`, and Codex's `shell_environment_policy` in `Harness.ts`).
 */
import { DaemonEnv, type Harness, OpenAIGateway } from "@dream/domain"
import { Option } from "effect"

/** Any value works: E2B's egress rule replaces the whole header. */
export const placeholderCredential = "dream-placeholder"

/** The ChatGPT backend Codex talks to when it runs on a ChatGPT plan. */
export const chatgptCodexBaseUrl = "https://chatgpt.com/backend-api/codex"

/** Never passed on: dreamd's own credentials, and the file they came from. */
const withheld = new Set<string>([DaemonEnv.projectToken, DaemonEnv.daemonToken, "DREAM_ENV_FILE"])

export const harnessEnv = (
  processEnv: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>>
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && !withheld.has(key)) env[key] = value
  }
  return { ...env, ...overrides }
}

/**
 * The environment of every process dreamd starts for the agent. `DREAM_SOCKET`
 * is set explicitly because dreamd may have read it from its env file, and
 * `dream` must find dreamd from anywhere.
 */
export const agentEnv = (
  processEnv: Readonly<Record<string, string | undefined>>,
  config: { readonly home: string; readonly socket: string }
): Record<string, string> =>
  harnessEnv(processEnv, {
    ...systemTrust(processEnv),
    HOME: config.home,
    [DaemonEnv.socket]: config.socket,
    DISABLE_AUTOUPDATER: "1"
  })

/** The system's CA bundle, which holds E2B's egress CA alongside the public roots. */
export const systemCaBundle = "/etc/ssl/certs/ca-certificates.crt"

/**
 * E2B's egress decrypts and re-signs HTTPS to every host with a rule (the model's, a connected service's, the AI
 * gateway's) with its own CA, which the system trusts and curl uses. Node, Bun and Python's `requests` and `httpx`
 * bring their own roots and refuse it, so the agent's apps couldn't reach those hosts; pointing them at the system
 * bundle fixes that. A value already set is kept.
 */
const systemTrust = (processEnv: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]
      .filter((name) => processEnv[name] === undefined)
      .map((name) => [name, systemCaBundle])
  )

/** What the agent's commands and apps get to call Dream's AI gateway with any OpenAI SDK, while it's on. */
export const gatewayEnv = (openaiBaseUrl: Option.Option<string>): Record<string, string> =>
  Option.match(openaiBaseUrl, {
    onNone: () => ({}),
    onSome: (url) => ({ OPENAI_BASE_URL: url, OPENAI_API_KEY: OpenAIGateway.placeholderKey })
  })

/** The environment of a command dreamd runs itself (`dream wake --run`): the agent's, with the gateway's variables. */
export const commandEnv = (
  processEnv: Readonly<Record<string, string | undefined>>,
  config: { readonly home: string; readonly socket: string; readonly openaiBaseUrl: Option.Option<string> }
): Record<string, string> => ({ ...agentEnv(processEnv, config), ...gatewayEnv(config.openaiBaseUrl) })

/**
 * The environment a harness process runs in. Claude Code reads neither gateway variable, so it carries them to
 * its Bash tool and everything that starts. Codex gets the agent's plain environment: its commands get the
 * variables through `shell_environment_policy.set` instead (`Harness.ts`), so its own process never holds them.
 */
export const sessionEnv = (
  harness: Harness,
  processEnv: Readonly<Record<string, string | undefined>>,
  config: { readonly home: string; readonly socket: string; readonly openaiBaseUrl: Option.Option<string> }
): Record<string, string> => (harness === "claude-code" ? commandEnv(processEnv, config) : agentEnv(processEnv, config))

/**
 * How each harness authenticates, given to its adapter as an explicit
 * environment so it never looks for a login of its own.
 *
 * Codex runs as an API-key provider against the ChatGPT backend: with no
 * `auth.json` it has no refresh token, so it can't rotate the shared login
 * out from under Dream's central refresh.
 */
export const harnessAuth = (harness: Harness): Record<string, string> =>
  harness === "claude-code"
    ? { CLAUDE_CODE_OAUTH_TOKEN: placeholderCredential }
    : { CODEX_API_KEY: placeholderCredential, OPENAI_BASE_URL: chatgptCodexBaseUrl }
