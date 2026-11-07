/**
 * What the harness processes (and so the agent's shell, and every app it
 * starts) see: this sandbox's environment without dreamd's tokens, plus the
 * placeholder model credential each harness needs. The real credential is
 * added at egress (`ModelEgress`); nothing here can refresh it.
 */
import { DaemonEnv, type Harness } from "@dream/domain"

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
 *
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` takes `run_in_background` out of Claude Code's `Agent` and `Bash` tools,
 * so subagents and commands run in the foreground and the turn waits for them. The harness bridge ends a turn at
 * the model's last reply and stops the CLI, so background work would otherwise die with it and its results never
 * reach the agent. An interim guard until turns wait for background work.
 */
export const agentEnv = (
  processEnv: Readonly<Record<string, string | undefined>>,
  config: { readonly home: string; readonly socket: string }
): Record<string, string> =>
  harnessEnv(processEnv, {
    HOME: config.home,
    [DaemonEnv.socket]: config.socket,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1"
  })

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
