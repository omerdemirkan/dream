/**
 * The fixtures backend wired into the same services the real API backs:
 * `AppClient` is a real RPC client talking to the fake's handlers in memory,
 * and `LiveProjects` streams the fake's project events.
 */
import { AppRpcs } from "@dream/domain"
import { Effect, Layer } from "effect"
import { RpcTest } from "effect/rpc"
import { AppAuthClient, AppClient, signingOut } from "../data/AppClient.ts"
import { LiveProjects } from "../data/LiveProjects.ts"
import { FakeAppAuth, FakeBackend, FakeHandlers } from "./FakeBackend.ts"

export const AppClientFake = Layer.effect(AppClient, RpcTest.makeClient(AppRpcs).pipe(Effect.flatMap(signingOut))).pipe(
  Layer.provide(Layer.mergeAll(FakeHandlers, FakeAppAuth, AppAuthClient))
)

export const LiveProjectsFake = Layer.effect(
  LiveProjects,
  Effect.gen(function* () {
    const backend = yield* FakeBackend
    return LiveProjects.of({ subscribe: backend.subscribe })
  })
)
