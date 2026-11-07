#!/usr/bin/env node
// Carries a project's running servers across a move to a sandbox of another size (apps/api/src/e2b/Move.ts). Memory
// can't move, so this notes what was running and starts it again on the other side.
//
//   node /opt/dream/sandbox/move.mjs capture   (as root, in the old sandbox) writes ~/.dream/move/processes.json:
//                                              the agent's servers (processes outside dreamd's tree listening on a
//                                              TCP port), as their session leader's command, directory, environment
//                                              and output files; and the other processes it would leave behind
//   node /opt/dream/sandbox/move.mjs restore   (as user, in the new sandbox, after the home directory came over)
//                                              starts each server again, detached, waits for its ports, and prints
//                                              {"restarted": [...], "notRestarted": [...]} as command lines
import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const home = "/home/user"
const state = `${home}/.dream/move/processes.json`
const read = (path) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** pid → { ppid, sid, uid } for every process. */
const processes = () => {
  const all = new Map()
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue
    const stat = read(`/proc/${name}/stat`)
    const status = read(`/proc/${name}/status`)
    if (stat === undefined || status === undefined) continue
    // "pid (comm) state ppid pgrp session …": comm can hold spaces, so split after its closing paren.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1)
    all.set(Number(name), { ppid: Number(fields[1]), sid: Number(fields[3]), uid })
  }
  return all
}

/** Listening TCP ports, by socket inode. */
const listeningInodes = () => {
  const ports = new Map()
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (read(table) ?? "").split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 10 || parts[3] !== "0A") continue
      ports.set(parts[9], Number.parseInt(parts[1].split(":")[1], 16))
    }
  }
  return ports
}

/** The TCP ports `pid` listens on. */
const portsOf = (pid, listening) => {
  const ports = new Set()
  let fds = []
  try {
    fds = readdirSync(`/proc/${pid}/fd`)
  } catch {
    return ports
  }
  for (const fd of fds) {
    let target = ""
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`)
    } catch {
      continue
    }
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
    if (inode !== undefined && listening.has(inode)) ports.add(listening.get(inode))
  }
  return ports
}

const argv = (pid) => (read(`/proc/${pid}/cmdline`) ?? "").split("\0").filter((arg) => arg.length > 0)
const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)
const commandLine = (args) => args.map(quote).join(" ")

const capture = () => {
  const all = processes()
  const userUid = all.size > 0 ? Number(execFileSync("id", ["-u", "user"], { encoding: "utf8" }).trim()) : 1000
  // dreamd's tree: the supervisor and everything under it (dreamd, the harness, its tools).
  const supervisor = Number(read("/tmp/dream-supervisor.pid")?.trim() ?? -1)
  const inTree = (pid) => {
    for (let at = pid, hops = 0; at > 1 && hops < 64; hops++) {
      if (at === supervisor) return true
      at = all.get(at)?.ppid ?? 0
    }
    return false
  }
  const theirs = [...all.entries()].filter(([pid, p]) => p.uid === userUid && !inTree(pid) && pid !== process.pid)
  const listening = listeningInodes()
  const sessions = new Map()
  for (const [pid, p] of theirs) {
    // A server started with `setsid nohup` leads its own session; restart that, not a child it spawned.
    const leader = all.get(p.sid)?.uid === userUid && !inTree(p.sid) ? p.sid : pid
    const entry = sessions.get(leader) ?? { ports: new Set() }
    for (const port of portsOf(pid, listening)) entry.ports.add(port)
    sessions.set(leader, entry)
  }
  const servers = []
  const others = []
  for (const [leader, { ports }] of sessions) {
    const args = argv(leader)
    if (args.length === 0) continue
    if (ports.size === 0) {
      others.push(commandLine(args))
      continue
    }
    const output = (fd) => {
      try {
        const target = readlinkSync(`/proc/${leader}/fd/${fd}`)
        return target.startsWith("/") && !target.startsWith("/dev/") && !target.startsWith("/proc/") ? target : undefined
      } catch {
        return undefined
      }
    }
    servers.push({
      argv: args,
      cwd: readlinkSync(`/proc/${leader}/cwd`),
      env: Object.fromEntries(
        (read(`/proc/${leader}/environ`) ?? "")
          .split("\0")
          .filter((pair) => pair.includes("="))
          .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)])
      ),
      stdout: output(1),
      stderr: output(2),
      ports: [...ports].sort((a, b) => a - b)
    })
  }
  mkdirSync(dirname(state), { recursive: true })
  writeFileSync(state, JSON.stringify({ servers, others }, null, 2))
  execFileSync("chown", ["-R", "user:user", dirname(state)])
  console.log(JSON.stringify({ servers: servers.map((s) => commandLine(s.argv)), others }))
}

const listeningPorts = () => new Set(listeningInodes().values())

const restore = async () => {
  if (!existsSync(state)) return console.log(JSON.stringify({ restarted: [], notRestarted: [] }))
  const { servers, others } = JSON.parse(readFileSync(state, "utf8"))
  const started = []
  for (const server of servers) {
    const log = `${home}/.dream/move/server-${started.length + 1}.log`
    const open = (path) => openSync(path ?? log, "a")
    let out
    let err
    try {
      out = open(server.stdout)
      err = server.stderr === server.stdout ? out : open(server.stderr)
    } catch {
      out = open(log)
      err = out
    }
    const child = spawn(server.argv[0], server.argv.slice(1), {
      cwd: existsSync(server.cwd) ? server.cwd : home,
      env: server.env,
      detached: true,
      stdio: ["ignore", out, err]
    })
    child.on("error", () => undefined)
    child.unref()
    closeSync(out)
    if (err !== out) closeSync(err)
    started.push(server)
  }
  // Give them up to 30 s to listen again.
  const deadline = Date.now() + 30_000
  const up = (server) => server.ports.every((port) => listeningPorts().has(port))
  while (Date.now() < deadline && !started.every(up)) await new Promise((resolve) => setTimeout(resolve, 500))
  const restarted = started.filter(up).map((s) => commandLine(s.argv))
  const failed = started.filter((s) => !up(s)).map((s) => `${commandLine(s.argv)} (started again, but not listening on ${s.ports.join(", ")} yet)`)
  console.log(JSON.stringify({ restarted, notRestarted: [...failed, ...others] }))
}

const [command] = process.argv.slice(2)
if (command === "capture") capture()
else if (command === "restore") await restore()
else {
  console.error("usage: move.mjs capture | restore")
  process.exit(2)
}
