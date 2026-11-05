/**
 * Replies typed into a notification: retried while the connection is the problem, and kept as a draft (with the
 * message's request id) when they still don't go through.
 */
import { InvalidRequest, type MessageId, type ProjectId, RequestId } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Option } from "effect"
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError"
import { TestClock } from "effect/testing"
import { AppClient } from "../src/data/AppClient.ts"
import { draftKey, Replies } from "../src/data/Replies.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"

const projectId = Fx.liftLog.id as ProjectId
const requestId = RequestId.make("7d0b6f1e-2c4a-4e8b-9f3d-1a2b3c4d5e6f")
const chat = { _tag: "Chat", projectId } as const
const answer = { _tag: "Answer", projectId, messageId: Fx.cabinQuestion.id as MessageId } as const

/** An API that fails the first `failures` calls with `error`, then succeeds. */
const api = (failures: number, error: () => unknown) => {
  const calls: Array<string> = []
  const fail = <A>(tag: string, value: A) =>
    Effect.suspend(() => {
      calls.push(tag)
      return calls.length <= failures ? Effect.fail(error()) : Effect.succeed(value)
    })
  const client = {
    SendMessage: () => fail("SendMessage", Fx.liftLogUpdate),
    AnswerQuestion: () => fail("AnswerQuestion", Fx.cabinQuestion)
  } as unknown as AppClient["Service"]
  return { calls, layer: Replies.layer.pipe(Layer.provide(Layer.succeed(AppClient, client))) }
}

const offline = () =>
  new RpcClientError({ reason: new RpcClientDefect({ message: "offline", cause: new Error("offline") }) })

const withStorage = <A, E>(layer: Layer.Layer<Replies, never, SecureStorage>, effect: Effect.Effect<A, E, Replies>) =>
  effect.pipe(Effect.provide(layer.pipe(Layer.provideMerge(SecureStorage.layerMemory()))))

describe("replies from a notification", () => {
  it.effect("retries a reply the connection dropped, and keeps no draft once it's sent", () => {
    const { calls, layer } = api(2, offline)
    return withStorage(
      layer,
      Effect.gen(function* () {
        const replies = yield* Replies
        const fiber = yield* replies.send({ ...chat, text: "Add deadlifts", requestId }).pipe(Effect.forkChild)
        yield* TestClock.adjust("2 seconds")
        yield* TestClock.adjust("4 seconds")
        const sent = yield* Fiber.join(fiber)
        assert.strictEqual(sent.id, Fx.liftLogUpdate.id)
        assert.deepStrictEqual(calls, ["SendMessage", "SendMessage", "SendMessage"])
        assert.isTrue(Option.isNone(yield* replies.draft(draftKey(chat))))
      })
    )
  })

  it.effect("keeps a reply that never went through as Chat's draft, with its request id", () => {
    const { calls, layer } = api(10, offline)
    return withStorage(
      layer,
      Effect.gen(function* () {
        const replies = yield* Replies
        const fiber = yield* replies.send({ ...chat, text: "Add deadlifts", requestId }).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 minute")
        assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)))
        assert.strictEqual(calls.length, 4)
        assert.deepStrictEqual(yield* replies.draft(draftKey(chat)), Option.some({ text: "Add deadlifts", requestId }))
        yield* replies.clearDraft(chat)
        assert.isTrue(Option.isNone(yield* replies.draft(draftKey(chat))))
      })
    )
  })

  it.effect("doesn't retry an answer the API refused, and keeps it in the question", () => {
    const { calls, layer } = api(10, () => new InvalidRequest({ message: "This question was withdrawn." }))
    return withStorage(
      layer,
      Effect.gen(function* () {
        const replies = yield* Replies
        const error = yield* replies.send({ ...answer, text: "Whoever books first", requestId }).pipe(Effect.flip)
        assert.strictEqual(error._tag, "InvalidRequest")
        assert.deepStrictEqual(calls, ["AnswerQuestion"])
        assert.deepStrictEqual(yield* replies.draft(draftKey(answer)), Option.some({ text: "Whoever books first" }))
        assert.isTrue(Option.isNone(yield* replies.draft(draftKey(chat))))
      })
    )
  })
})
