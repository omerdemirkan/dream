#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Runtime } from "effect"
import { bootstrap } from "../Bootstrap.ts"
import { layer, main } from "../Daemon.ts"

if (process.argv[2] === "bootstrap") {
  bootstrap.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
} else {
  // Exit as soon as `main` is done, even when it succeeded: a child process or socket nothing closed would
  // otherwise keep a stopped dreamd alive, and its supervisor waiting.
  main.pipe(
    Effect.provide(layer),
    NodeRuntime.runMain({
      teardown: (exit, onExit) =>
        Runtime.defaultTeardown(exit, (code) => {
          onExit(code)
          process.exit(code)
        })
    })
  )
}
