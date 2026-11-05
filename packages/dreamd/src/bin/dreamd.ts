#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { bootstrap } from "../Bootstrap.ts"
import { layer, main } from "../Daemon.ts"

if (process.argv[2] === "bootstrap") {
  bootstrap.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
} else {
  main.pipe(Effect.provide(layer), NodeRuntime.runMain)
}
