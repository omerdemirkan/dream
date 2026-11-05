#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { layer, main } from "../Daemon.ts"

main.pipe(Effect.provide(layer), NodeRuntime.runMain)
