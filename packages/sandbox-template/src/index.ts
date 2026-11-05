/**
 * The E2B template every project sandbox starts from (`dream-sandbox`):
 *
 * - Node 24 (Debian 12), git, build tools, Python, ripgrep, jq, ffmpeg, an SSH
 *   client, Pillow and basic fonts, and Playwright (on PATH, so `npx playwright`
 *   works offline) with its Chromium and system libraries; `chromium` and
 *   `chrome` on PATH run that browser
 * - pnpm (the harness adapters install their bridges with it) and Bun
 * - dreamd and the `dream` CLI in /opt/dream, run from TypeScript source by
 *   Node's type stripping, with dependencies installed from the repo's bun.lock
 * - both harnesses pre-installed (`dreamd bootstrap`): each adapter's bridge
 *   with its pinned Claude Code or Codex CLI
 * - a supervisor as the start command that keeps dreamd running; dreamd waits
 *   for the env file the ProjectDO writes (`DaemonEnvFile`)
 *
 * The CLIs need more memory than E2B's base sandbox has (installs OOM at
 * 512 MB), so the template asks for 4 vCPU and 8 GB, the Hobby maximum.
 *
 * Build it with `bun run template:build` (see scripts/build.ts).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DefaultDaemonPort } from "@dream/domain"
import { Template } from "e2b"

/** The template name sandboxes are created from. */
export const templateName = "dream-sandbox"

export const resources = { cpuCount: 4, memoryMB: 8192 } as const

/** Disk the template should leave free for projects, in MiB (E2B grows the filesystem when it can). */
export const minFreeDiskMb = 10_240

/** Versions installed in the image. Bump deliberately; they're not tied to the repo's lockfile. */
export const versions = { pnpm: "12.14.0", bun: "1.4.4", playwright: "1.64.1" } as const

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))

/**
 * Copy what the image needs from this repo into a fresh directory: the
 * workspace packages dreamd uses, the lockfile, and the template's own files.
 * The copied root package.json lists only those packages; Bun installs from
 * the same lockfile and skips the rest.
 */
export const stageContext = (): string => {
  const context = mkdtempSync(join(tmpdir(), "dream-template-"))
  const dream = join(context, "dream")
  mkdirSync(dream)
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>
  writeFileSync(
    join(dream, "package.json"),
    `${JSON.stringify({ ...rootPackage, workspaces: ["packages/*"], scripts: {} }, null, 2)}\n`
  )
  for (const file of ["bun.lock", "tsconfig.base.json"]) cpSync(join(repoRoot, file), join(dream, file))
  for (const [pkg, dirs] of [
    ["domain", ["src"]],
    ["agent-context", ["src"]],
    ["dreamd", ["src", "scripts"]]
  ] as const) {
    cpSync(join(repoRoot, "packages", pkg, "package.json"), join(dream, "packages", pkg, "package.json"))
    for (const dir of dirs)
      cpSync(join(repoRoot, "packages", pkg, dir), join(dream, "packages", pkg, dir), { recursive: true })
  }
  cpSync(join(repoRoot, "packages/sandbox-template/files"), join(dream, "sandbox"), { recursive: true })
  return context
}

const aptPackages = [
  "git",
  "curl",
  "ca-certificates",
  "build-essential",
  "pkg-config",
  "python3",
  "python3-pip",
  "python3-venv",
  "jq",
  "ripgrep",
  "fd-find",
  "unzip",
  "zip",
  "xz-utils",
  "openssh-client",
  "procps",
  "lsof",
  "less",
  "file",
  "sqlite3",
  "ffmpeg",
  "tmux",
  "sudo",
  "python3-pil",
  "fontconfig",
  "fonts-dejavu-core"
]

/** The template, built from a context made by `stageContext`. */
export const makeTemplate = (context: string) =>
  Template({ fileContextPath: context })
    .fromNodeImage("24")
    .aptInstall(aptPackages, { noInstallRecommends: true })
    .runCmd(
      [
        `npm install -g pnpm@${versions.pnpm}`,
        `curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s bun-v${versions.bun}`,
        `npm install -g playwright@${versions.playwright}`,
        "PLAYWRIGHT_BROWSERS_PATH=/opt/playwright playwright install --with-deps chromium",
        "chmod -R a+rX /opt/playwright",
        "fc-cache -f",
        "ln -sf /usr/bin/fdfind /usr/local/bin/fd"
      ],
      { user: "root" }
    )
    .copy("dream", "/opt/dream", { user: "root" })
    .runCmd(
      [
        "cd /opt/dream && bun install --frozen-lockfile --production",
        "install -m 755 /opt/dream/sandbox/dream /opt/dream/sandbox/dreamd /usr/local/bin/",
        "install -m 755 /opt/dream/sandbox/chromium /usr/local/bin/ && ln -sf chromium /usr/local/bin/chrome",
        "chmod 755 /opt/dream/sandbox/supervisor.sh",
        "echo '. /opt/dream/sandbox/env.sh' > /etc/profile.d/dream.sh",
        "mkdir -p /home/user/project /home/user/.dream/logs && chown -R user:user /home/user"
      ],
      { user: "root" }
    )
    .runCmd(". /opt/dream/sandbox/env.sh && dreamd bootstrap", { user: "user" })
    .setUser("user")
    .setWorkdir("/home/user/project")
    .setStartCmd(
      "/opt/dream/sandbox/supervisor.sh",
      "test -f /tmp/dream-supervisor.pid && kill -0 $(cat /tmp/dream-supervisor.pid)"
    )

/** dreamd's port; the ProjectDO reaches it at `https://<port>-<sandbox>.e2b.app`. */
export const daemonPort = DefaultDaemonPort
