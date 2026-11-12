/**
 * The models the installed harness CLI knows, from the CLI itself, and what a project's model choice runs as.
 *
 * A project chooses a family (`AgentModels` in the domain: `fable`, `sol`), never a version, and each turn runs on
 * the family's newest model in the CLI this sandbox has. The CLIs ship with the template, and a refresh brings a new
 * build's CLIs and restarts dreamd, so what's read here once per dreamd is what every turn until the next restart
 * runs on:
 *
 * - Claude Code takes the family's alias, and each release points it at the family's newest model (2.1.322: `fable`
 *   → claude-fable-5-2), so the alias goes to the harness as it is. Its own model list, which its `initialize`
 *   control request returns without a model call or a login (`value`, `resolvedModel`, `supportedEffortLevels`),
 *   says which model that is, for the agent's note when it changes (`Session.ts`). Without the list a turn still
 *   runs; only the note is missing.
 * - Codex has no aliases, so the family becomes the newest slug of it in Codex's bundled catalog
 *   (`codex debug models --bundled`, about 20 ms): listed models whose slug is `gpt-<version>-<family>`, with the
 *   multi-agent tools (`multi_agent_version` v2; a thread keeps the tools it started with, and without them the agent
 *   can't start subagents), highest version first. Codex can't run a family name, so without the catalog the turn
 *   fails, and the next one tries again.
 *
 * A name that isn't a family or a Codex slug of one (an operator's QA override such as `gpt-5.5`, or a Claude id,
 * which pins its model) goes as it is. The
 * update script (`scripts/update-harnesses.ts`) reads both catalogs from the CLIs it pins, with these functions, and
 * refuses a pin where a family Dream offers no longer resolves or no longer takes every effort.
 */
import { join } from "node:path"
import { AgentModels, familyOf, type Harness, type ReasoningEffort } from "@dream/domain"
import { Context, Data, Duration, Effect, FileSystem, Layer, Option, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DreamdConfig } from "../Config.ts"
import { binDir } from "./Bridges.ts"

/** One model in a CLI's own list. */
export interface CatalogModel {
  /** The concrete model: `claude-fable-5-2`, `gpt-6.1-sol`. */
  readonly id: string
  /** Claude Code's alias for it (`fable`), which is what the harness is given. */
  readonly alias?: string
  /** As the CLI names it to people. */
  readonly name: string
  /** Codex: whether its picker lists it (the rest are hidden or internal). Claude Code lists all it returns. */
  readonly listed: boolean
  /** Whether it gets the tools to start subagents: on Codex, multi-agent v2; Claude Code's Agent tool is on all. */
  readonly orchestrates: boolean
  readonly efforts: ReadonlyArray<string>
}

export class ModelsError extends Data.TaggedError("ModelsError")<{ readonly message: string }> {}

// ---------------------------------------------------------------------------
// Reading the CLIs' lists
// ---------------------------------------------------------------------------

const CodexCatalog = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        display_name: Schema.optionalKey(Schema.String),
        visibility: Schema.optionalKey(Schema.String),
        supported_reasoning_levels: Schema.optionalKey(Schema.Array(Schema.Struct({ effort: Schema.String }))),
        multi_agent_version: Schema.optionalKey(Schema.NullOr(Schema.String))
      })
    )
  })
)
const decodeCodexCatalog = Schema.decodeUnknownOption(CodexCatalog)

/** `codex debug models --bundled`'s output. */
export const parseCodexCatalog = (stdout: string): Option.Option<ReadonlyArray<CatalogModel>> =>
  Option.map(decodeCodexCatalog(stdout), ({ models }) =>
    models.map((model) => ({
      id: model.slug,
      name: model.display_name ?? model.slug,
      listed: model.visibility === "list",
      orchestrates: model.multi_agent_version === "v2",
      efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort)
    }))
  )

/** The control request Claude Code answers with its commands, models and account, before any model call. */
export const claudeInitialize = `${JSON.stringify({
  type: "control_request",
  request_id: "dream-models",
  request: { subtype: "initialize" }
})}\n`

const ClaudeInitialized = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("control_response"),
    response: Schema.Struct({
      request_id: Schema.Literal("dream-models"),
      response: Schema.Struct({
        models: Schema.Array(
          Schema.Struct({
            value: Schema.String,
            resolvedModel: Schema.optionalKey(Schema.String),
            displayName: Schema.optionalKey(Schema.String),
            supportedEffortLevels: Schema.optionalKey(Schema.Array(Schema.String))
          })
        )
      })
    })
  })
)
const decodeClaudeInitialized = Schema.decodeUnknownOption(ClaudeInitialized)

/** People's name for a Claude id: `claude-fable-5-2` is "Fable 5.2". */
export const claudeName = (id: string): string => {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id)
  if (match === null) return id
  const [, family = "", version = ""] = match
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.replaceAll("-", ".")}`
}

/** Claude Code's answer to `claudeInitialize` (stream-json lines): its aliases and the models they stand for. */
export const parseClaudeModels = (stdout: string): Option.Option<ReadonlyArray<CatalogModel>> => {
  for (const line of stdout.split("\n")) {
    const answer = decodeClaudeInitialized(line.trim())
    if (Option.isNone(answer)) continue
    return Option.some(
      answer.value.response.response.models.flatMap((model): ReadonlyArray<CatalogModel> => {
        // "default" is whatever the account's default is, not a family.
        if (model.resolvedModel === undefined || model.value === "default") return []
        return [
          {
            id: model.resolvedModel,
            alias: model.value,
            name: claudeName(model.resolvedModel),
            listed: true,
            orchestrates: true,
            efforts: model.supportedEffortLevels ?? []
          }
        ]
      })
    )
  }
  return Option.none()
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

const versionOf = (id: string): ReadonlyArray<number> =>
  (/^gpt-(\d+(?:\.\d+)*)-/.exec(id)?.[1] ?? "").split(".").map(Number)

const newer = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x = 0, y = 0] = [a[i], b[i]]
    if (x !== y) return x > y
  }
  return false
}

/** The family's newest model in `catalog`: Claude Code's alias's model; Codex's highest listed slug that orchestrates. */
export const newestOf = (
  harness: Harness,
  catalog: ReadonlyArray<CatalogModel>,
  family: string
): Option.Option<CatalogModel> => {
  if (harness === "claude-code") return Option.fromUndefinedOr(catalog.find((model) => model.alias === family))
  let best: CatalogModel | undefined
  for (const model of catalog) {
    if (!model.listed || !model.orchestrates || familyOf("codex", model.id) !== family) continue
    if (best === undefined || newer(versionOf(model.id), versionOf(best.id))) best = model
  }
  return Option.fromUndefinedOr(best)
}

/** What a model choice runs as. */
export interface Resolved {
  /** What the harness is given: Claude Code's alias, a Codex slug, or the name as it came. */
  readonly model: string
  /** The concrete model, when the CLI's list says. */
  readonly concrete: Option.Option<CatalogModel>
}

/** `model` (a family, a Codex slug of one, or any other name) on `harness`, given the installed CLI's list. */
export const resolveIn = (
  harness: Harness,
  catalog: Option.Option<ReadonlyArray<CatalogModel>>,
  model: string
): Effect.Effect<Resolved, ModelsError> => {
  const family = familyOf(harness, model)
  const listed = Option.getOrElse(catalog, () => [])
  if (family === undefined) {
    return Effect.succeed({
      model,
      concrete: Option.fromUndefinedOr(listed.find((entry) => entry.id === model || entry.alias === model))
    })
  }
  if (harness === "claude-code") return Effect.succeed({ model: family, concrete: newestOf(harness, listed, family) })
  if (Option.isNone(catalog)) {
    return Effect.fail(
      new ModelsError({ message: `Codex's model catalog couldn't be read, so ${family} has no model` })
    )
  }
  return Option.match(newestOf(harness, catalog.value, family), {
    onNone: () =>
      Effect.fail(
        new ModelsError({ message: `Codex's catalog has no model of the ${family} family that orchestrates` })
      ),
    onSome: (newest) => Effect.succeed({ model: newest.id, concrete: Option.some(newest) })
  })
}

/**
 * What's wrong with `catalog` for Dream: a family it offers that has no model, or whose model doesn't take every
 * effort Dream offers. Nothing when the CLI can run all of them. Used by the update script on each new pin.
 */
export const catalogProblems = (
  harness: Harness,
  catalog: ReadonlyArray<CatalogModel>,
  efforts: ReadonlyArray<ReasoningEffort>
): ReadonlyArray<string> =>
  AgentModels[harness].flatMap((option) =>
    Option.match(newestOf(harness, catalog, option.id), {
      onNone: () => [
        `${harness} has no model of the ${option.id} family${harness === "codex" ? " that orchestrates" : ""}`
      ],
      onSome: (model) => {
        const missing = efforts.filter((effort) => !model.efforts.includes(effort))
        return missing.length === 0 ? [] : [`${model.id} (${option.id}) doesn't take effort ${missing.join(", ")}`]
      }
    })
  )

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Past this the CLI's answer counts as missing. */
const readTimeout = Duration.seconds(20)

/** How to ask each CLI for its list, given where `dreamd bootstrap` installed it and a scratch directory. */
export const catalogCommand = (harness: Harness, bins: string, scratch: string) =>
  harness === "claude-code"
    ? {
        command: join(bins, "claude-code", "node_modules", ".bin", "claude"),
        args: ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        stdin: claudeInitialize,
        // Its own config dir, so nothing of the agent's is read or written, and no network: the list is built in.
        env: {
          HOME: scratch,
          CLAUDE_CONFIG_DIR: join(scratch, "claude"),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9"
        }
      }
    : {
        command: join(bins, "codex", "node_modules", ".bin", "codex"),
        args: ["debug", "models", "--bundled"],
        stdin: "",
        env: { HOME: scratch, CODEX_HOME: join(scratch, "codex") }
      }

export class Models extends Context.Service<
  Models,
  {
    /** The installed CLI's list, read once (a failed read is tried again next time). */
    readonly catalog: Effect.Effect<Option.Option<ReadonlyArray<CatalogModel>>>
    /** What `model` runs as on this sandbox's harness. */
    readonly resolve: (model: string) => Effect.Effect<Resolved, ModelsError>
  }
>()("@dream/dreamd/Models") {
  static readonly layer = Layer.effect(
    Models,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const harness = config.harness
      const scratch = join(config.stateDir, "models")
      const call = catalogCommand(harness, binDir(config.home), scratch)
      const read = Effect.scoped(
        Effect.gen(function* () {
          yield* fs.makeDirectory(scratch, { recursive: true })
          const handle = yield* spawner.spawn(
            ChildProcess.make(call.command, [...call.args], {
              cwd: scratch,
              env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...call.env },
              extendEnv: false,
              stdin: { stream: Stream.make(new TextEncoder().encode(call.stdin)) }
            })
          )
          const [stdout] = yield* Effect.all(
            [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
            { concurrency: 2 }
          )
          return harness === "claude-code" ? parseClaudeModels(stdout) : parseCodexCatalog(stdout)
        })
      ).pipe(
        Effect.timeoutOption(readTimeout),
        Effect.map(Option.flatten),
        Effect.catch((error) =>
          Effect.logWarning(`Couldn't read ${harness}'s model list`, { error: String(error) }).pipe(
            Effect.as(Option.none<ReadonlyArray<CatalogModel>>())
          )
        )
      )
      const cache = yield* Ref.make(Option.none<ReadonlyArray<CatalogModel>>())
      const catalog = Effect.gen(function* () {
        const cached = yield* Ref.get(cache)
        if (Option.isSome(cached)) return cached
        const fresh = yield* read
        if (Option.isSome(fresh)) yield* Ref.set(cache, fresh)
        else yield* Effect.logWarning(`${harness}'s model list wasn't readable`)
        return fresh
      })
      return Models.of({
        catalog,
        resolve: (model) => Effect.flatMap(catalog, (list) => resolveIn(harness, list, model))
      })
    })
  )

  /** A fixed list, as if the installed CLI returned it (`Option.none()`: it couldn't be read). */
  static readonly layerTest = (harness: Harness, catalog: Option.Option<ReadonlyArray<CatalogModel>>) =>
    Layer.succeed(
      Models,
      Models.of({
        catalog: Effect.succeed(catalog),
        resolve: (model) => resolveIn(harness, catalog, model)
      })
    )
}
