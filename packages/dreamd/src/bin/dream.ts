#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { Dream } from "../cli/Client.ts"
import * as Usage from "../cli/Usage.ts"
import { dream } from "../Cli.ts"
import { PageCheck } from "../cli/PageCheck.ts"
import { version } from "../version.ts"

dream.pipe(
  Command.run({ version }),
  Effect.provide(
    PageCheck.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(Dream.layer, FetchHttpClient.layer, NodeServices.layer, Usage.layer))
    )
  ),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
