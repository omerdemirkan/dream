/**
 * Runtime configuration, read from the Worker's environment when a request
 * (or alarm, or cron) runs, never during init: init-time `Config` reads get
 * bound by alchemy at deploy, and operator secrets are set in the Cloudflare
 * dashboard instead (alchemy leaves dashboard secrets alone).
 *
 * Optional operator secrets resolve to `Option`; the service that needs one
 * fails with `UpstreamFailure` naming what's missing, so the rest of the API
 * keeps working before every provider is configured.
 */
import { NamespaceFederationIssuer, ReasoningEffort, UpstreamFailure } from "@dream/domain"
import { Config, Context, Duration, Effect, Layer, Option, Redacted } from "effect"

const optionalSecret = (name: string) => Config.option(Config.Redacted(name))
const optionalString = (name: string) => Config.option(Config.NonEmptyString(name))

export const ApiConfigSchema = Config.all({
  /** Apex domain, e.g. "omer.build". Published apps are `<slug>-<random>.<domain>`. */
  domain: Config.NonEmptyString("DREAM_DOMAIN"),
  /** The API's hostname. Defaults to `dream.<domain>`. */
  apiHost: optionalString("DREAM_API_HOST"),
  /** 32 random bytes, hex: the master key for `secrets` (generated at deploy). */
  encryptionKey: Config.Redacted("DREAM_ENCRYPTION_KEY"),
  /** HS256 key for sessions, project tokens and tickets (generated at deploy). */
  signingKey: Config.Redacted("DREAM_SIGNING_KEY"),
  /** Enables `DevSignIn` when set. */
  devLoginSecret: optionalSecret("DEV_LOGIN_SECRET"),
  /** Comma-separated Google OAuth client ids whose ID tokens `SignIn` accepts (the iOS client). */
  googleSignInClientIds: optionalString("GOOGLE_IOS_CLIENT_ID"),
  /** The web OAuth client used for integrations (Gmail, Calendar, …). */
  googleClientId: optionalString("GOOGLE_CLIENT_ID"),
  googleClientSecret: optionalSecret("GOOGLE_CLIENT_SECRET"),
  e2bApiKey: optionalSecret("E2B_API_KEY"),
  e2bApiUrl: Config.NonEmptyString("E2B_API_URL").pipe(Config.withDefault("https://api.e2b.app")),
  e2bDomain: Config.NonEmptyString("E2B_DOMAIN").pipe(Config.withDefault("e2b.app")),
  /** The template project sandboxes start from (built by packages/sandbox-template). */
  sandboxTemplate: Config.NonEmptyString("E2B_TEMPLATE").pipe(Config.withDefault("dream-sandbox")),
  /**
   * How long E2B lets a sandbox run before it pauses it, whatever its timeout ("1 hour" on Hobby, "24 hours" on
   * Pro). Resuming restarts the clock, so a long turn is paused and resumed just before the cap.
   */
  sandboxMaxRun: Config.Duration("E2B_SANDBOX_MAX_RUN").pipe(Config.withDefault(Duration.hours(1))),
  /**
   * Whether project sandboxes are brought up to the template's newest build between turns (see
   * `e2b/Refresh.ts`). On unless SANDBOX_REFRESH is "false".
   */
  sandboxRefresh: Config.Boolean("SANDBOX_REFRESH").pipe(Config.withDefault(true)),
  /** The template for short-lived model sign-in sandboxes; needs `claude` and `codex` on PATH. */
  authTemplate: optionalString("E2B_AUTH_TEMPLATE"),
  /**
   * Operator overrides of the fleet, for QA and calibration runs: without them every project's top-level agent
   * runs on its provider's flagship at high effort (dreamd's `harness/Fleet.ts`). Each is written to dreamd's env.
   *
   * - `DREAM_AGENT_MODEL`: Claude Code projects' model, as `DREAM_MODEL` (an id or alias `claude --model`
   *   accepts, e.g. "haiku" or "claude-haiku-4-5-20251001").
   * - `DREAM_CODEX_AGENT_MODEL`: Codex projects' model, as `DREAM_MODEL` (a slug in Codex's catalog, e.g.
   *   "gpt-6-luna").
   * - `DREAM_AGENT_EFFORT`: every project's reasoning effort, as `DREAM_EFFORT` (low, medium, high, xhigh, max).
   */
  agentModel: optionalString("DREAM_AGENT_MODEL"),
  codexAgentModel: optionalString("DREAM_CODEX_AGENT_MODEL"),
  agentEffort: Config.option(Config.schema(ReasoningEffort, "DREAM_AGENT_EFFORT")),
  /** How dreamd is started in a new sandbox (run with `bash -lc`). */
  daemonCommand: Config.NonEmptyString("DREAMD_COMMAND").pipe(Config.withDefault("dreamd")),
  apnsKeyId: optionalString("APNS_KEY_ID"),
  apnsTeamId: optionalString("APNS_TEAM_ID"),
  apnsBundleId: optionalString("APNS_BUNDLE_ID"),
  apnsPrivateKey: optionalSecret("APNS_PRIVATE_KEY"),
  /** "production" (TestFlight, App Store) or "development" (Xcode builds). */
  apnsEnvironment: Config.Literals(["production", "development"], "APNS_ENVIRONMENT").pipe(
    Config.withDefault("production" as const)
  ),
  browserbaseApiKey: optionalSecret("BROWSERBASE_API_KEY"),
  browserbaseProjectId: optionalString("BROWSERBASE_PROJECT_ID"),
  namespaceToken: optionalSecret("NAMESPACE_TOKEN"),
  namespaceApiUrl: Config.NonEmptyString("NAMESPACE_API_URL").pipe(
    Config.withDefault("https://us.compute.namespaceapis.com")
  ),
  /** Namespace workspace (tenant) whose build Macs may fetch `ascTestflightKey`. */
  namespaceTenantId: Config.NonEmptyString("NAMESPACE_TENANT_ID").pipe(Config.withDefault("tenant_lso1fm36nm1rq")),
  /** Namespace's federation issuer, whose JWKS signs build Macs' ID tokens. */
  namespaceFederationUrl: Config.NonEmptyString("NAMESPACE_FEDERATION_URL").pipe(
    Config.withDefault(NamespaceFederationIssuer)
  ),
  /**
   * The App Store Connect API key (`AuthKey_<id>.p8` contents) for Dream's own TestFlight builds, set by the
   * founder in the dashboard. Released only to a granted Namespace build Mac (http/Testflight.ts).
   */
  ascTestflightKey: optionalSecret("ASC_TESTFLIGHT_KEY_P8"),
  /** The app's URL scheme, for redirects back from OAuth. */
  appScheme: Config.NonEmptyString("APP_URL_SCHEME").pipe(Config.withDefault("dream"))
})

export type ApiConfigValues = typeof ApiConfigSchema extends Config.Config<infer A> ? A : never

export interface ApiConfigShape extends Omit<ApiConfigValues, "apiHost"> {
  readonly apiHost: string
  /** `https://<apiHost>` */
  readonly apiUrl: string
}

export class ApiConfig extends Context.Service<ApiConfig, ApiConfigShape>()("@dream/api/ApiConfig") {
  static readonly fromValues = (values: ApiConfigValues): ApiConfigShape => {
    const apiHost = Option.getOrElse(values.apiHost, () => `dream.${values.domain}`)
    return { ...values, apiHost, apiUrl: `https://${apiHost}` }
  }

  static readonly layer = Layer.effect(ApiConfig, Effect.map(ApiConfigSchema, ApiConfig.fromValues)).pipe(Layer.orDie)

  static readonly layerTest = (overrides: Partial<ApiConfigShape> = {}) =>
    Layer.succeed(ApiConfig, {
      ...ApiConfig.fromValues({
        domain: "dream.test",
        apiHost: Option.some("api.dream.test"),
        encryptionKey: Redacted.make("00".repeat(32)),
        signingKey: Redacted.make("test-signing-key"),
        devLoginSecret: Option.some(Redacted.make("dev-secret")),
        googleSignInClientIds: Option.some("ios-client.apps.googleusercontent.com"),
        googleClientId: Option.some("web-client.apps.googleusercontent.com"),
        googleClientSecret: Option.some(Redacted.make("google-secret")),
        e2bApiKey: Option.some(Redacted.make("e2b-key")),
        e2bApiUrl: "https://api.e2b.test",
        e2bDomain: "e2b.test",
        sandboxTemplate: "dream-sandbox",
        sandboxMaxRun: Duration.hours(1),
        sandboxRefresh: true,
        authTemplate: Option.none(),
        agentModel: Option.none(),
        codexAgentModel: Option.none(),
        agentEffort: Option.none(),
        daemonCommand: "dreamd",
        apnsKeyId: Option.some("KEYID12345"),
        apnsTeamId: Option.some("TEAMID1234"),
        apnsBundleId: Option.some("build.omer.dream"),
        apnsPrivateKey: Option.none(),
        apnsEnvironment: "development",
        browserbaseApiKey: Option.some(Redacted.make("bb-key")),
        browserbaseProjectId: Option.none(),
        namespaceToken: Option.some(Redacted.make("ns-token")),
        namespaceApiUrl: "https://ns.test",
        namespaceTenantId: "tenant_test",
        namespaceFederationUrl: NamespaceFederationIssuer,
        ascTestflightKey: Option.none(),
        appScheme: "dream"
      }),
      ...overrides
    })
}

/** The value of an optional operator setting, or `UpstreamFailure` saying it isn't configured. */
export const required = <A>(
  value: Option.Option<A>,
  service: string,
  name: string
): Effect.Effect<A, UpstreamFailure> =>
  Option.match(value, {
    onNone: () => Effect.fail(new UpstreamFailure({ service, message: `${name} isn't configured on this deployment` })),
    onSome: Effect.succeed
  })
