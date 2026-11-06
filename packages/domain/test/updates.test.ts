/**
 * The over-the-air update shapes the publish script and the Worker exchange (Updates.ts).
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import { PublishUpdateRequest, RollbackUpdateRequest, Routes, UpdateRelease, UpdatesStatus } from "../src/index.ts"

const json = <S extends Schema.Top>(schema: S) => Schema.toCodecJson(schema) as unknown as Schema.Codec<S["Type"], any>

const publish = {
  channel: "production",
  platform: "ios",
  runtimeVersion: "14bf5883ff7e3ef551e61c1a2de76dbf4589a863",
  launchAsset: { hash: "a".repeat(43), key: "bundle", contentType: "application/javascript" },
  assets: [{ hash: "b".repeat(43), key: "0a328cd9", contentType: "image/png", fileExtension: ".png" }],
  expoClient: { name: "Dream" },
  gitCommit: "a79fa56",
  message: "Fix the composer"
}

describe("update shapes", () => {
  it("decodes a publish request and turns down malformed ones", () => {
    assert.deepStrictEqual(Schema.decodeUnknownSync(json(PublishUpdateRequest))(publish), publish as any)
    const bad = [
      { ...publish, channel: "Production" },
      { ...publish, platform: "android" },
      { ...publish, runtimeVersion: "has space" },
      { ...publish, launchAsset: { ...publish.launchAsset, hash: "short" } },
      { ...publish, assets: [{ ...publish.assets[0], fileExtension: "png" }] },
      { ...publish, gitCommit: "main" }
    ]
    for (const value of bad)
      assert.isTrue(Schema.decodeUnknownExit(json(PublishUpdateRequest))(value)._tag === "Failure")
  })

  it("rolls back to an update id or the embedded bundle", () => {
    const base = { channel: "production", platform: "ios", runtimeVersion: "abc" }
    for (const to of [undefined, "embedded", "6f1c2b0e-0000-4000-8000-000000000000"]) {
      const value = to === undefined ? base : { ...base, to }
      assert.deepStrictEqual(Schema.decodeUnknownSync(json(RollbackUpdateRequest))(value), value as any)
    }
    assert.isTrue(Schema.decodeUnknownExit(json(RollbackUpdateRequest))({ ...base, to: "latest" })._tag === "Failure")
  })

  it("round-trips the status, releases as tagged JSON with ISO dates", () => {
    const createdAt = DateTime.makeUnsafe("2026-11-05T12:00:00.000Z")
    const status: UpdatesStatus = {
      channel: "production",
      runtimes: [
        {
          runtimeVersion: "abc",
          platform: "ios",
          releases: [
            UpdateRelease.cases.RollBackToEmbedded.make({ id: "6f1c2b0e-0000-4000-8000-000000000001", createdAt }),
            UpdateRelease.cases.Update.make({
              id: "6f1c2b0e-0000-4000-8000-000000000000",
              createdAt,
              gitCommit: "a79fa56",
              message: "first"
            })
          ],
          checkIn: { lastCheckAt: createdAt }
        }
      ]
    }
    const encoded = Schema.encodeSync(json(UpdatesStatus))(status)
    assert.strictEqual(encoded.runtimes[0].releases[0]._tag, "RollBackToEmbedded")
    assert.strictEqual(encoded.runtimes[0].releases[1].createdAt, "2026-11-05T12:00:00.000Z")
    assert.deepStrictEqual(Schema.decodeUnknownSync(json(UpdatesStatus))(encoded), status)
  })

  it("names the protocol's routes", () => {
    assert.strictEqual(Routes.updatesManifest, "/updates/manifest")
    assert.strictEqual(Routes.updatesAsset("x"), "/updates/assets/x")
  })
})
