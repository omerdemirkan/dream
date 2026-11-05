/**
 * files/refresh.sh against a fake sandbox tree (ROOT): stub CLIs and a stub supervisor that records its start.
 * Needs bash, setsid and pkill (Linux); skipped elsewhere.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, assert, describe, it } from "@effect/vitest"

const script = fileURLToPath(new URL("../files/refresh.sh", import.meta.url))
const available = ["setsid", "pkill"].every((tool) => spawnSync("which", [tool]).status === 0)

const write = (path: string, content: string, mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  chmodSync(path, mode)
}

/** A copy of Dream at `tree` and harness bridges at `bridges`, labelled `release`; `claude` fails if `broken`. */
const install = (root: string, tree: string, bridges: string, release: string, broken = false) => {
  write(join(tree, "release.json"), JSON.stringify({ release }))
  write(join(tree, "packages/dreamd/src/bin/dream.ts"), 'console.log("dream")\n')
  for (const name of ["dream", "dreamd", "chromium"])
    write(join(tree, "sandbox", name), `#!/bin/sh\necho ${release}\n`, 0o755)
  // The stub supervisor says which release it runs and stays up, like the real one.
  write(
    join(tree, "sandbox/supervisor.sh"),
    `#!/bin/bash\necho $$ > ${root}/tmp/dream-supervisor.pid\necho ${release} >> ${root}/started\nexec sleep 300\n`,
    0o755
  )
  write(
    join(bridges, "claude-code/node_modules/.bin/claude"),
    `#!/bin/sh\n${broken ? "exit 1" : "echo 2.1.318"}\n`,
    0o755
  )
  write(join(bridges, "codex/node_modules/.bin/codex"), "#!/bin/sh\necho 0.165.0\n", 0o755)
  write(join(bridges, "claude-code/.bootstrap-a.ok"), "")
  write(join(bridges, "codex/.bootstrap-b.ok"), "")
}

describe.skipIf(!available)("refresh.sh", () => {
  let root = ""
  const dream = () => join(root, "opt/dream")
  const bridges = () => join(root, "home/user/.ai-sdk-harness/.harness-bootstrap")
  const run = (command: string) =>
    spawnSync("bash", [script, command], {
      env: { ...process.env, ROOT: root, REFRESH_USER: userInfo().username },
      encoding: "utf8"
    })
  const release = (dir: string) => JSON.parse(readFileSync(join(dir, "release.json"), "utf8")).release
  const started = () => readFileSync(join(root, "started"), "utf8").trim().split("\n")
  const waitForStart = (count: number) => {
    for (let i = 0; i < 50 && (!existsSync(join(root, "started")) || started().length < count); i++) {
      execFileSync("sleep", ["0.1"])
    }
  }

  const setup = (broken = false) => {
    root = mkdtempSync(join(tmpdir(), "refresh-sh-"))
    mkdirSync(join(root, "tmp"))
    mkdirSync(join(root, "usr/local/bin"), { recursive: true })
    install(root, dream(), bridges(), "old")
    write(join(bridges(), "../.agent-runs/session/bridge/state"), "conversation")
    install(root, `${dream()}.next`, `${bridges()}.next`, "new", broken)
  }

  afterEach(() => {
    spawnSync("pkill", ["-f", `${root}/opt/dream`])
    rmSync(root, { recursive: true, force: true })
  })

  it("activate swaps the staged copies in, keeps the old ones, and starts the new supervisor; commit drops the old", () => {
    setup()
    const activated = run("activate")
    assert.strictEqual(activated.status, 0, activated.stderr + activated.stdout)
    assert.strictEqual(release(dream()), "new")
    assert.strictEqual(release(`${dream()}.prev`), "old")
    assert.isFalse(existsSync(`${dream()}.next`))
    assert.strictEqual(
      readFileSync(join(bridges(), "claude-code/node_modules/.bin/claude"), "utf8").includes("2.1.318"),
      true
    )
    assert.strictEqual(readFileSync(join(root, "usr/local/bin/dream"), "utf8"), "#!/bin/sh\necho new\n")
    assert.isTrue(existsSync(join(root, "usr/local/bin/chrome")))
    // The harnesses' per-session state is beside the bootstrap, not in it, and stays.
    assert.strictEqual(readFileSync(join(bridges(), "../.agent-runs/session/bridge/state"), "utf8"), "conversation")
    waitForStart(1)
    assert.deepStrictEqual(started(), ["new"])

    const committed = run("commit")
    assert.strictEqual(committed.status, 0)
    assert.isFalse(existsSync(`${dream()}.prev`))
    assert.isFalse(existsSync(`${bridges()}.prev`))
    assert.strictEqual(release(dream()), "new")
  })

  it("rollback puts the old copies back and starts the old supervisor", () => {
    setup()
    assert.strictEqual(run("activate").status, 0)
    waitForStart(1)
    const rolledBack = run("rollback")
    assert.strictEqual(rolledBack.status, 0, rolledBack.stderr + rolledBack.stdout)
    assert.strictEqual(release(dream()), "old")
    assert.isFalse(existsSync(`${dream()}.prev`))
    assert.isFalse(existsSync(`${dream()}.failed`))
    assert.strictEqual(readFileSync(join(root, "usr/local/bin/dream"), "utf8"), "#!/bin/sh\necho old\n")
    waitForStart(2)
    assert.deepStrictEqual(started(), ["new", "old"])
  })

  it("a staged copy whose CLI doesn't run is refused before anything changes", () => {
    setup(true)
    const activated = run("activate")
    assert.notStrictEqual(activated.status, 0)
    assert.strictEqual(release(dream()), "old")
    assert.isTrue(existsSync(`${dream()}.next`))
    assert.isFalse(existsSync(join(root, "started")))
  })
})
