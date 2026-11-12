/**
 * Which Claude Code and Codex the harness bridges install. Each adapter ships a bridge manifest (a package.json and
 * pnpm lockfile) pinning its CLI, and lags upstream releases by weeks; Dream keeps its own copy of each manifest in
 * `bridges/<harness>/`, the same but for the CLI versions, and gives the adapter's bootstrap recipe those files
 * instead. The recipe's identity is a hash of its files, so a new pin is a new recipe: `dreamd bootstrap` installs
 * it when the template is built, and a sandbox refreshed from that template gets the install and its marker.
 *
 * Dream also edits the bridge code where an adapter has no setting for what it needs (`bridgePatches`), and adds
 * files of its own beside it (`bridgeExtras`).
 *
 * `scripts/update-harnesses.ts` (`bun run harness:update`) writes the manifests; `test/bridges.test.ts` checks they still match the installed
 * adapters' apart from the CLIs, and that every patch still applies.
 */
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { HarnessV1 } from "@ai-sdk/harness"

export type PinnedHarness = "claude-code" | "codex"

/** The packages Dream pins in each bridge; everything else in it is the adapter's. */
export const cliPackages: Readonly<Record<PinnedHarness, ReadonlyArray<string>>> = {
  "claude-code": ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-code"],
  codex: ["@openai/codex"]
}

export const bridgesDir = fileURLToPath(new URL("./bridges/", import.meta.url))

/** Where `dreamd bootstrap` installs the pinned CLIs, each bridge in a directory named for its harness. */
export const binDir = (home: string) => join(home, ".ai-sdk-harness", ".harness-bootstrap")

const adapterPackage: Readonly<Record<PinnedHarness, string>> = {
  "claude-code": "@ai-sdk/harness-claude-code",
  codex: "@ai-sdk/harness-codex"
}

/** Where the installed adapter keeps its own bridge manifest. */
export const adapterBridgeDir = (harness: PinnedHarness): string =>
  join(dirname(createRequire(import.meta.url).resolve(adapterPackage[harness])), "bridge")

/** The recipe files Dream replaces, by name within the bootstrap directory. */
const replaced = ["package.json", "pnpm-lock.yaml"] as const

/** The recipe file holding the bridge's code, by name within the bootstrap directory. */
export const bridgeFile = "bridge.mjs"

/** Files Dream adds to each bridge, beside `bridge.mjs`, from `bridges/<harness>/`. */
export const bridgeExtras: Readonly<Record<PinnedHarness, ReadonlyArray<string>>> = {
  "claude-code": ["background.mjs"],
  codex: ["background.mjs"]
}

export interface BridgePatch {
  /** Text that occurs exactly once in the adapter's bridge code. */
  readonly find: string
  readonly replace: string
}

/**
 * Edits to each adapter's bridge code. A patch that no longer finds its text fails the bootstrap (and the test),
 * so an adapter upgrade can't drop it silently.
 *
 * Claude Code records a conversation's system prompt on its first request and sends that record on every later
 * request and resume until the conversation compacts, ignoring the text a later launch passes (`snapshot`, on by
 * default, in the Agent SDK's `systemPrompt`). The project's session lives for weeks, so a new prompt from a
 * template refresh would never reach it. `snapshot: false` renders the prompt on every request instead, from what
 * dreamd passes, which is the same text until the template changes it. The adapter has no setting for it.
 *
 * Claude Code's turn also holds while background work runs (`bridges/claude-code/background.mjs`): the adapter
 * would end it at the model's first reply and stop the CLI with its background subagents, shells and Monitors in
 * it. The patches route the CLI's messages through Dream's tracker and let it decide when a turn that had
 * background work is over; a turn without any ends where the adapter ends it.
 *
 * Codex's turn holds the same way for the root agent's children (`bridges/codex/background.mjs`): the app-server
 * driver tells Dream's tracker what it hears about them, waits after the root's turn completes while they run, then
 * starts another root turn with their final answers (or with a message steered in meanwhile), and adds up the
 * root turns' usage.
 */
export const bridgePatches: Readonly<Record<PinnedHarness, ReadonlyArray<BridgePatch>>> = {
  "claude-code": [
    { find: `preset: "claude_code",\n`, replace: `preset: "claude_code",\n\t\tsnapshot: false,\n` },
    {
      find: `import { argv, env, pid, stdout } from "node:process";\n`,
      replace:
        `import { argv, env, pid, stdout } from "node:process";\n` +
        `import { createDreamBackground, quietType as dreamBackgroundQuiet } from "./background.mjs";\n`
    },
    {
      find: [
        `\ttry {`,
        `\t\tfor await (const msg of messages()) {`,
        `\t\t\tif (abortCtl.signal.aborted) break;`,
        `\t\t\tconst type = msg.type;`,
        `\t\t\tif (type === "command_lifecycle") queryInput.handleLifecycle(msg);`,
        `\t\t\tconst sessionId = msg.session_id;`,
        `\t\t\tif (typeof sessionId === "string" && sessionId.length > 0) lastClaudeSessionId = sessionId;`,
        `\t\t\temitStreamEvent(msg);`,
        ``
      ].join("\n"),
      replace: [
        `\tconst dreamBackground = createDreamBackground();`,
        `\ttry {`,
        `\t\tfor await (const msg of dreamBackground.watch(messages())) {`,
        `\t\t\tif (abortCtl.signal.aborted) break;`,
        `\t\t\tconst type = msg.type;`,
        `\t\t\tif (type === dreamBackgroundQuiet) {`,
        `\t\t\t\tif (queryInput.hasObservedResult && !queryInput.hasActiveUserMessages() && dreamBackground.endNow({ graceOver: true })) {`,
        `\t\t\t\t\tqueryInput.close();`,
        `\t\t\t\t\tbreak;`,
        `\t\t\t\t}`,
        `\t\t\t\tcontinue;`,
        `\t\t\t}`,
        `\t\t\tif (type === "command_lifecycle") queryInput.handleLifecycle(msg);`,
        `\t\t\tconst sessionId = msg.session_id;`,
        `\t\t\tif (typeof sessionId === "string" && sessionId.length > 0) lastClaudeSessionId = sessionId;`,
        `\t\t\tdreamBackground.observe(msg);`,
        `\t\t\temitStreamEvent(dreamBackground.forStream(msg));`,
        `\t\t\tconst dreamReport = dreamBackground.report();`,
        `\t\t\tif (dreamReport !== void 0) emit({ type: "raw", rawValue: dreamReport });`,
        `\t\t\tif (type === "system" && msg.subtype === "session_state_changed" && msg.state === "idle" && dreamBackground.engaged() && queryInput.hasObservedResult && !queryInput.hasActiveUserMessages() && dreamBackground.endNow()) {`,
        `\t\t\t\tqueryInput.close();`,
        `\t\t\t\tbreak;`,
        `\t\t\t}`,
        ``
      ].join("\n")
    },
    {
      find: [
        `\t\t\t\t\tif (!resumingDeferredCall && !queryInput.answersSentMessage(msg)) continue;`,
        `\t\t\t\t\tqueryInput.observeResult();`,
        `\t\t\t\t\tif (!queryInput.hasActiveUserMessages()) {`,
        `\t\t\t\t\t\tqueryInput.close();`,
        ``
      ].join("\n"),
      replace: [
        `\t\t\t\t\tdreamBackground.result();`,
        `\t\t\t\t\tconst dreamHeld = dreamBackground.report();`,
        `\t\t\t\t\tif (dreamHeld !== void 0) emit({ type: "raw", rawValue: dreamHeld });`,
        `\t\t\t\t\tif (!resumingDeferredCall && !queryInput.answersSentMessage(msg)) {`,
        `\t\t\t\t\t\tif (dreamBackground.engaged() && queryInput.hasObservedResult && !queryInput.hasActiveUserMessages() && dreamBackground.endNow()) {`,
        `\t\t\t\t\t\t\tqueryInput.close();`,
        `\t\t\t\t\t\t\tbreak;`,
        `\t\t\t\t\t\t}`,
        `\t\t\t\t\t\tcontinue;`,
        `\t\t\t\t\t}`,
        `\t\t\t\t\tqueryInput.observeResult();`,
        `\t\t\t\t\tif (!queryInput.hasActiveUserMessages()) {`,
        `\t\t\t\t\t\tif (dreamBackground.engaged() && !dreamBackground.endNow()) continue;`,
        `\t\t\t\t\t\tqueryInput.close();`,
        ``
      ].join("\n")
    },
    {
      find: [
        `\t\t\tif (queryInput.hasObservedResult && !queryInput.hasActiveUserMessages()) {`,
        `\t\t\t\tqueryInput.close();`,
        `\t\t\t\tbreak;`,
        `\t\t\t}`,
        `\t\t}`,
        `\t} catch (err) {`
      ].join("\n"),
      replace: [
        `\t\t\tif (queryInput.hasObservedResult && !queryInput.hasActiveUserMessages() && !dreamBackground.engaged()) {`,
        `\t\t\t\tqueryInput.close();`,
        `\t\t\t\tbreak;`,
        `\t\t\t}`,
        `\t\t}`,
        `\t} catch (err) {`
      ].join("\n")
    }
  ],
  codex: [
    {
      find: `import { isDeepStrictEqual } from "node:util";\n`,
      replace:
        `import { isDeepStrictEqual } from "node:util";\n` +
        `import { addUsage as dreamAddUsage, createDreamChildren } from "./background.mjs";\n`
    },
    {
      find: `\tlet loadedConfig;\n\tlet activeTurn;\n\tconst close = async () => {\n`,
      replace: `\tlet loadedConfig;\n\tlet activeTurn;\n\tconst dreamChildren = createDreamChildren();\n\tconst close = async () => {\n`
    },
    {
      find: [
        `\t\t\t\tonNotification: (notification) => {`,
        `\t\t\t\t\tif (client !== created || activeTurn == null) return;`,
        ``
      ].join("\n"),
      replace: [
        `\t\t\t\tonNotification: (notification) => {`,
        `\t\t\t\t\tif (client === created) dreamChildren.observe(notification, loadedThreadId);`,
        `\t\t\t\t\tif (client !== created || activeTurn == null) return;`,
        ``
      ].join("\n")
    },
    {
      find: `\t\t\tfor await (const message of turn.experimental_userMessages) try {\n`,
      replace: [
        `\t\t\tfor await (const message of turn.experimental_userMessages) try {`,
        `\t\t\t\tif (dreamChildren.holding()) {`,
        `\t\t\t\t\tdreamChildren.steer(message);`,
        `\t\t\t\t\tcontinue;`,
        `\t\t\t\t}`,
        ``
      ].join("\n")
    },
    {
      find: `\t\tlet keepClient = false;\n`,
      replace: `\t\tlet keepClient = false;\n\t\tlet dreamWaiting = false;\n`
    },
    {
      find: [
        `\t\t\tconst result = await raceWithProcess({ operation: handler.waitForCompletion() });`,
        `\t\t\tkeepClient = true;`,
        `\t\t\tassertSuccessfulTurn(result);`,
        ``
      ].join("\n"),
      replace: [
        `\t\t\tconst result = await raceWithProcess({ operation: handler.waitForCompletion() });`,
        `\t\t\tkeepClient = true;`,
        `\t\t\tassertSuccessfulTurn(result);`,
        `\t\t\tfor (;;) {`,
        `\t\t\t\tdreamWaiting = true;`,
        `\t\t\t\tconst next = await raceWithProcess({ operation: dreamChildren.settle((report) => emit({ type: "raw", rawValue: report })) });`,
        `\t\t\t\tdreamWaiting = false;`,
        `\t\t\t\tif (next === void 0) break;`,
        `\t\t\t\tconst followUp = createAppServerEventHandler({`,
        `\t\t\t\t\tstepTracker: options.stepTracker,`,
        `\t\t\t\t\temitStreamEvent: (event) => {`,
        `\t\t\t\t\t\tif (event.type !== "thread.started") options.emitStreamEvent(event);`,
        `\t\t\t\t\t},`,
        `\t\t\t\t\temitWarning: turn.emitWarning,`,
        `\t\t\t\t\temitError: turn.emitError`,
        `\t\t\t\t});`,
        `\t\t\t\tfollowUp.announceThread(currentTurn.threadId);`,
        `\t\t\t\tcurrentTurn.handler = followUp;`,
        `\t\t\t\tcurrentTurn.turnId = void 0;`,
        `\t\t\t\ttry {`,
        `\t\t\t\t\tcurrentTurn.turnId = readNestedString({`,
        `\t\t\t\t\t\tvalue: await raceWithProcess({ operation: runningClient.request({`,
        `\t\t\t\t\t\t\tmethod: "turn/start",`,
        `\t\t\t\t\t\t\tparams: {`,
        `\t\t\t\t\t\t\t\t...createTurnParams({ threadId: currentTurn.threadId, start, codexModel, disableEnvironments: toolPolicy.disableEnvironments }),`,
        `\t\t\t\t\t\t\t\tinput: [{ type: "text", text: next.input, text_elements: [] }]`,
        `\t\t\t\t\t\t\t}`,
        `\t\t\t\t\t\t}) }),`,
        `\t\t\t\t\t\tpath: ["turn", "id"],`,
        `\t\t\t\t\t\tmethod: "turn/start"`,
        `\t\t\t\t\t});`,
        `\t\t\t\t} catch (error) {`,
        `\t\t\t\t\tfor (const message of next.messages) message.reject(error);`,
        `\t\t\t\t\tthrow error;`,
        `\t\t\t\t}`,
        `\t\t\t\tfollowUp.setTurnId(currentTurn.turnId);`,
        `\t\t\t\tfor (const message of next.messages) message.accept();`,
        `\t\t\t\tassertSuccessfulTurn(await raceWithProcess({ operation: followUp.waitForCompletion() }));`,
        `\t\t\t}`,
        ``
      ].join("\n")
    },
    {
      // Stopped while it waited on children (dreamd's limit): stop the app-server with them, rather than leave them.
      find: `\t\t\tthrow error;\n\t\t} finally {\n\t\t\tturn.experimental_userMessages.close();\n`,
      replace: `\t\t\tif (dreamWaiting) keepClient = false;\n\t\t\tthrow error;\n\t\t} finally {\n\t\t\tturn.experimental_userMessages.close();\n`
    },
    {
      find: `\t\tsetTurnUsage: (usage) => turnUsage = usage,\n`,
      replace: `\t\tsetTurnUsage: (usage) => turnUsage = dreamAddUsage(turnUsage, usage),\n`
    }
  ]
}

/** The bridge code with `patches` applied; throws if one doesn't find its text exactly once. */
export const patchBridge = (code: string, patches: ReadonlyArray<BridgePatch>): string =>
  patches.reduce((patched, { find, replace }) => {
    const parts = patched.split(find)
    if (parts.length !== 2) {
      throw new Error(`A bridge patch found its text ${parts.length - 1} times, not once: ${JSON.stringify(find)}`)
    }
    return parts.join(replace)
  }, code)

/**
 * The adapter, with a bootstrap recipe that installs Dream's pinned CLI: the adapter's own recipe (its bridge code,
 * workspace settings and install commands) with Dream's manifest and lockfile, its bridge code patched, and Dream's
 * extra files beside it.
 */
export const withPinnedCli = <H extends Pick<HarnessV1, "getBootstrap">>(harness: PinnedHarness, adapter: H): H => {
  const getBootstrap = adapter.getBootstrap
  if (getBootstrap === undefined) return adapter
  return {
    ...adapter,
    getBootstrap: async (options?: { abortSignal?: AbortSignal }) => {
      const recipe = await getBootstrap(options)
      const pinned = Object.fromEntries(
        await Promise.all(
          replaced.map(async (name) => [name, await readFile(join(bridgesDir, harness, name), "utf8")] as const)
        )
      )
      const extras = await Promise.all(
        bridgeExtras[harness].map(async (name) => ({
          path: `${recipe.bootstrapDir}/${name}`,
          content: await readFile(join(bridgesDir, harness, name), "utf8")
        }))
      )
      const prefix = `${recipe.bootstrapDir}/`
      return {
        ...recipe,
        files: [
          ...recipe.files.map((file) => {
            const name = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : undefined
            if (name === bridgeFile) return { ...file, content: patchBridge(file.content, bridgePatches[harness]) }
            const content = name === undefined ? undefined : pinned[name]
            return content === undefined ? file : { ...file, content }
          }),
          ...extras
        ]
      }
    }
  }
}
