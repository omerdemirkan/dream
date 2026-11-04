#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { main } from "../Daemon.ts"

main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
