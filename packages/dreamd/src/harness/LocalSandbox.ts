/**
 * The harness's view of this machine. dreamd runs inside the E2B sandbox, so
 * `HarnessAgent` drives Claude Code or Codex locally: commands and files are
 * the sandbox's own, and the bridge port is on loopback.
 *
 * This implements the `@ai-sdk/harness` sandbox interfaces, which are
 * Promise-based; it's the edge between the SDK and the machine, and the only
 * place dreamd spawns harness processes. Every child gets `env` (see
 * `HarnessEnv.ts`), never dreamd's own environment, so the project and daemon
 * tokens don't leak into the agent's shell or the apps it starts.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process"
import { createReadStream } from "node:fs"
import * as fs from "node:fs/promises"
import { createServer } from "node:net"
import { constants } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import type { HarnessV1NetworkSandboxSession, HarnessV1PortEndpoint } from "@ai-sdk/harness"
import {
  type Experimental_SandboxSession as SandboxSession,
  type Experimental_SandboxProcess as SandboxProcess,
  extractLines
} from "@ai-sdk/provider-utils"

type SpawnOptions = Parameters<SandboxSession["run"]>[0] & { readonly stdin?: boolean }
type WritableProcess = SandboxProcess & { readonly stdin: WritableStream<Uint8Array> }

const makeSession = (cwd: string, env: Readonly<Record<string, string>>, children: Set<ChildProcess>) => {
  const resolvePath = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path))

  const spawnChild = (options: SpawnOptions) => {
    options.abortSignal?.throwIfAborted()
    const child = nodeSpawn(options.command, {
      shell: "/bin/bash",
      cwd: options.workingDirectory === undefined ? cwd : resolvePath(options.workingDirectory),
      env: { ...env, ...options.env },
      stdio: [options.stdin === true ? "pipe" : "ignore", "pipe", "pipe"],
      ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal })
    })
    children.add(child)
    child.once("exit", () => children.delete(child))
    return child
  }

  const run: SandboxSession["run"] = (options) =>
    new Promise((resolvePromise, reject) => {
      const child = spawnChild(options)
      const stdout: Array<Buffer> = []
      const stderr: Array<Buffer> = []
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.once("error", reject)
      child.once("close", (code, signal) =>
        resolvePromise({
          exitCode: exitCodeOf(code, signal),
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString()
        })
      )
    })

  const spawnProcess = async (options: SpawnOptions): Promise<SandboxProcess | WritableProcess> => {
    const child = spawnChild(options)
    const exited = new Promise<{ exitCode: number }>((resolvePromise, reject) => {
      let settled = false
      const settle = (f: () => void) => {
        if (!settled) {
          settled = true
          f()
        }
      }
      child.once("error", (error) =>
        settle(() => reject(options.abortSignal?.aborted ? options.abortSignal.reason : error))
      )
      child.once("exit", (code, signal) =>
        settle(() =>
          options.abortSignal?.aborted
            ? reject(options.abortSignal.reason)
            : resolvePromise({ exitCode: exitCodeOf(code, signal) })
        )
      )
    })
    exited.catch(() => {})
    const process: SandboxProcess = {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill: async () => {
        child.kill()
      }
    }
    return child.stdin === null
      ? process
      : { ...process, stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array> }
  }

  const readBinaryFile: SandboxSession["readBinaryFile"] = async ({ path }) => {
    try {
      const buffer = await fs.readFile(resolvePath(path))
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  const writeBinaryFile: SandboxSession["writeBinaryFile"] = async ({ path, content }) => {
    const full = resolvePath(path)
    await fs.mkdir(dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }

  const session: SandboxSession = {
    description: `The Dream sandbox, rooted at ${cwd}.`,
    run,
    spawn: spawnProcess as SandboxSession["spawn"],
    readFile: async ({ path }) => {
      const full = resolvePath(path)
      const stats = await fs.stat(full).catch((error: unknown) => (isNotFound(error) ? null : Promise.reject(error)))
      if (stats === null) return null
      if (stats.isDirectory()) throw Object.assign(new Error(`EISDIR: ${full} is a directory`), { code: "EISDIR" })
      return Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>
    },
    readBinaryFile,
    readTextFile: async ({ path, encoding, startLine, endLine }) => {
      const bytes = await readBinaryFile({ path })
      if (bytes === null) return null
      const text = Buffer.from(bytes).toString((encoding ?? "utf-8") as BufferEncoding)
      return extractLines({
        text,
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine })
      })
    },
    writeFile: async ({ path, content }) =>
      writeBinaryFile({ path, content: new Uint8Array(await new Response(content).arrayBuffer()) }),
    writeBinaryFile,
    writeTextFile: ({ path, content, encoding }) =>
      writeBinaryFile({ path, content: Buffer.from(content, (encoding ?? "utf-8") as BufferEncoding) }),
    stat: async ({ path }) => {
      try {
        const stats = await fs.stat(resolvePath(path))
        return { type: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other", size: stats.size }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    listDirectory: async ({ path }) => {
      try {
        const entries = await fs.readdir(resolvePath(path), { withFileTypes: true })
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isFile()
            ? "file"
            : entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other"
        }))
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    deleteFile: async ({ path }) => {
      try {
        await fs.rm(resolvePath(path))
        return true
      } catch (error) {
        if (isNotFound(error)) return false
        throw error
      }
    }
  }
  return session
}

/**
 * A sandbox session rooted at `cwd` whose processes see only `env`. The bridge
 * port is free when the session starts; the bridge binds it on loopback.
 */
export const makeLocalSandboxSession = async (options: {
  readonly id: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}): Promise<HarnessV1NetworkSandboxSession> => {
  const cwd = resolve(options.cwd)
  await fs.mkdir(cwd, { recursive: true })
  const children = new Set<ChildProcess>()
  const session = makeSession(cwd, options.env, children)
  let ports: ReadonlyArray<number> = [await freePort()]
  const getPortEndpoint = async (port: { port: number; protocol?: "http" | "https" | "ws" }) =>
    ({ url: `${port.protocol ?? "http"}://127.0.0.1:${port.port}` }) satisfies HarnessV1PortEndpoint
  /** Stops only what this session spawned; the sandbox itself belongs to E2B. */
  const stop = async () => {
    const running = [...children]
    children.clear()
    await Promise.all(running.map(terminate))
  }
  return {
    ...session,
    id: options.id,
    defaultWorkingDirectory: cwd,
    get ports() {
      return ports
    },
    getPortEndpoint,
    getPortUrl: async (port) => (await getPortEndpoint(port)).url,
    setPorts: async (next) => {
      ports = [...next]
    },
    stop,
    destroy: stop,
    restricted: () => session
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => resolvePromise(port))
    })
  })

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? (signal === null ? 0 : 128 + (constants.signals[signal] ?? 0))

const terminate = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolvePromise) => {
        const kill = setTimeout(() => child.kill("SIGKILL"), 2_000)
        child.once("exit", () => {
          clearTimeout(kill)
          resolvePromise()
        })
        child.kill("SIGTERM")
      })
