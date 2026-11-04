/**
 * Typed failures that cross a boundary. RPCs declare which of these they can
 * fail with; anything else is a defect.
 */
import { Schema } from "effect"

/** Missing, expired or invalid session / project / daemon token. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String
}) {}

/** Their Google account is not on the invite list. */
export class NotInvited extends Schema.TaggedError<NotInvited>()("NotInvited", {
  email: Schema.String
}) {}

/** The entity does not exist, or belongs to someone else (which is reported the same way). */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String
}) {}

/**
 * The request is well-formed but can't be applied, e.g. answering a withdrawn
 * question or picking an option the question doesn't have. `message` is
 * written for whoever made the call (the agent, via `dream`, or the app).
 */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  message: Schema.String
}) {}

/** Creating a project needs a connected model subscription for its harness. */
export class NoModelConnection extends Schema.TaggedError<NoModelConnection>()("NoModelConnection", {
  message: Schema.String
}) {}

/** A service Dream depends on failed: E2B, APNs, Google, Anthropic, OpenAI, Browserbase, Namespace, … */
export class UpstreamFailure extends Schema.TaggedError<UpstreamFailure>()("UpstreamFailure", {
  service: Schema.String,
  message: Schema.String
}) {}
