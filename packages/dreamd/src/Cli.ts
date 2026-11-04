/**
 * The `dream` command. Each subcommand maps to one `SandboxRpcs` call (the RPC
 * doc comments name the command and flags) sent to dreamd over its Unix socket.
 *
 * Skeleton only: the sandbox-runtime workstream adds the subcommands.
 */
import { Command } from "effect/cli"

export const dream = Command.make("dream").pipe(
  Command.withDescription(
    "Reach the person and Dream from this sandbox: messages, questions, access, status, wake-ups, publishing, a browser, a Mac, and usage."
  )
)
