/**
 * Who is calling. Each RPC group that needs a caller declares one of these
 * middlewares; the server implements it (verifying the bearer token and
 * providing the identity), and because each is `requiredForClient`, every
 * client must also provide a client middleware that attaches the token.
 *
 * Tokens travel as `authorization: Bearer <token>`.
 */
import { Context } from "effect"
import { RpcMiddleware } from "effect/rpc"
import { Unauthorized } from "./Errors.ts"
import type { ProjectId, UserId } from "./Ids.ts"

/** The signed-in person, provided by `AppAuth` from their Dream session token. */
export class CurrentUser extends Context.Service<
  CurrentUser,
  {
    readonly userId: UserId
    readonly email: string
  }
>()("@dream/domain/CurrentUser") {}

/** The project a sandbox belongs to, provided by `SandboxAuth` from the project token. */
export class CurrentProject extends Context.Service<
  CurrentProject,
  {
    readonly projectId: ProjectId
    readonly userId: UserId
  }
>()("@dream/domain/CurrentProject") {}

/** Phone → API. Bearer: the Dream session JWT the app keeps in SecureStore. */
export class AppAuth extends RpcMiddleware.Service<AppAuth, { provides: CurrentUser }>()("@dream/domain/AppAuth", {
  error: Unauthorized,
  requiredForClient: true
}) {}

/** dreamd → API. Bearer: the project-scoped token dreamd gets in `DREAM_PROJECT_TOKEN`. */
export class SandboxAuth extends RpcMiddleware.Service<SandboxAuth, { provides: CurrentProject }>()(
  "@dream/domain/SandboxAuth",
  { error: Unauthorized, requiredForClient: true }
) {}

/**
 * ProjectDO → dreamd. Bearer: the per-sandbox secret in `DREAM_DAEMON_TOKEN`.
 * Apps in the sandbox can reach dreamd's port on localhost; this keeps them
 * from forging the person's messages into the agent's inbox.
 */
export class DaemonAuth extends RpcMiddleware.Service<DaemonAuth>()("@dream/domain/DaemonAuth", {
  error: Unauthorized,
  requiredForClient: true
}) {}
