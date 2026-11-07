/**
 * Turning what the harness already says into a line for the person, with no model: an imperative command
 * description becomes an -ing phrase ("Run the scorer tests" → "Running the scorer tests"), and a sentence of the
 * model's summarized thinking becomes its first clause ("I'm setting up unit tests for the realtime session, using
 * a mock…" → "Setting up unit tests for the realtime session").
 *
 * A phrase is refused rather than mangled: anything that reads like code (paths, file names, identifiers, flags,
 * backticks, URLs), anything about the machinery (agents, sessions, tokens, prompts), and any deliberation
 * ("I'm weighing whether…") is dropped. Pure.
 */

/** Verbs whose -ing form doubles the last consonant. */
const doubles = new Set([
  "run",
  "rerun",
  "get",
  "set",
  "reset",
  "stop",
  "put",
  "cut",
  "plan",
  "ship",
  "drop",
  "swap",
  "grab",
  "log",
  "dig",
  "hit",
  "sit",
  "shut",
  "skip",
  "step",
  "strip",
  "trim",
  "wrap",
  "chat",
  "pin",
  "tag",
  "map",
  "scan",
  "spin",
  "commit",
  "submit",
  "begin",
  "forget",
  "admit",
  "permit",
  "refer",
  "prefer",
  "occur",
  "omit",
  "unpin",
  "debug",
  "plug",
  "unplug",
  "zip",
  "unzip",
  "chop",
  "nap",
  "snap",
  "tap",
  "stub",
  "rig",
  "rub",
  "scrub",
  "sum",
  "jam"
])

const irregular: Readonly<Record<string, string>> = {
  be: "being",
  see: "seeing",
  flee: "fleeing",
  agree: "agreeing",
  free: "freeing",
  die: "dying",
  lie: "lying",
  tie: "tying",
  untie: "untying",
  dye: "dyeing",
  eye: "eyeing",
  hoe: "hoeing",
  toe: "toeing",
  shoe: "shoeing"
}

/** The -ing form of an English verb: "run" → "running", "make" → "making", "tie" → "tying". */
export const gerund = (verb: string): string => {
  const lower = verb.toLowerCase()
  const known = irregular[lower]
  let form: string
  if (known !== undefined) form = known
  else if (lower.endsWith("ing") && lower.length > 5) form = lower
  else if (doubles.has(lower)) form = `${lower}${lower.at(-1)}ing`
  else if (lower.endsWith("ie")) form = `${lower.slice(0, -2)}ying`
  else if (lower.endsWith("e") && !/(ee|ye|oe)$/.test(lower) && lower.length > 2) form = `${lower.slice(0, -1)}ing`
  else form = `${lower}ing`
  return verb[0] === verb[0]?.toUpperCase() ? capitalize(form) : form
}

export const capitalize = (text: string) => (text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1))

/** Verbs a command description or a plan step starts with, which become -ing. */
const verbs = new Set([
  "add",
  "adjust",
  "apply",
  "ask",
  "build",
  "bump",
  "change",
  "check",
  "clean",
  "clear",
  "clone",
  "commit",
  "compare",
  "compile",
  "configure",
  "connect",
  "convert",
  "copy",
  "create",
  "debug",
  "delete",
  "deploy",
  "design",
  "download",
  "draft",
  "edit",
  "enable",
  "ensure",
  "explore",
  "export",
  "extract",
  "fetch",
  "find",
  "finish",
  "fix",
  "format",
  "generate",
  "grab",
  "handle",
  "import",
  "improve",
  "install",
  "investigate",
  "kill",
  "launch",
  "lint",
  "list",
  "load",
  "look",
  "make",
  "measure",
  "merge",
  "migrate",
  "mint",
  "move",
  "open",
  "parse",
  "patch",
  "pick",
  "pin",
  "polish",
  "prepare",
  "probe",
  "profile",
  "publish",
  "pull",
  "push",
  "read",
  "rebuild",
  "record",
  "refactor",
  "regenerate",
  "reinstall",
  "reload",
  "remove",
  "rename",
  "render",
  "reproduce",
  "rerun",
  "research",
  "reset",
  "restart",
  "retake",
  "recheck",
  "redo",
  "restore",
  "retry",
  "review",
  "rewrite",
  "run",
  "save",
  "scaffold",
  "scan",
  "search",
  "seed",
  "send",
  "serve",
  "set",
  "setup",
  "show",
  "simplify",
  "sketch",
  "smoke",
  "sort",
  "split",
  "start",
  "stop",
  "store",
  "switch",
  "sync",
  "take",
  "test",
  "tidy",
  "train",
  "transcribe",
  "try",
  "tune",
  "turn",
  "update",
  "upgrade",
  "upload",
  "use",
  "validate",
  "verify",
  "wait",
  "watch",
  "wire",
  "write"
])

/** Descriptions that say the agent is only looking around, which says nothing to the person. */
const lookingAround = new Set([
  "read",
  "list",
  "show",
  "find",
  "locate",
  "print",
  "inspect",
  "view",
  "cat",
  "count",
  "look",
  "see",
  "open"
])

/** Words about the machinery, never shown to the person. */
const machinery =
  /\b(sub-?agents?|agents?|session|turn|dream|placeholder|token|credential|proxy|prompt|skill|memory|context|harness|monitor|tool|tools|egress|sandbox|api key|keys?|secret|env(ironment)? var)/i

/** Reads like code or a command line. A bare scheme ("Fetching https") is what's left of a URL cut short. */
const codeLike =
  /`|https?:\/\/|\b(?:https?|wss?|ftp)\b|\bwww\b|\w\/\w|\w\.\w{1,5}\b|\b\w+-\w*\d|\/\w|\b[a-z]+[A-Z]\w*|\b\w+_\w+|(^|\s)--?\w|[{}[\]<>=|$#@\\]|\w\(|\bnpm\b|\bpnpm\b|\bnpx\b|\bvitest\b|\bpytest\b|\bgit\b|\bcurl\b/

/** The person is "they" to the agent; the line speaks to them. */
const toThem = (text: string) =>
  text
    .replace(/\bthe user's\b/gi, "your")
    .replace(/\bthe user\b/gi, "you")
    .replace(/\btheir\b/g, "your")

/**
 * The first clause: up to a comma, a dash, "since", "because", "so", "then", "which", "while", "before", "to see".
 * A URL's colon doesn't end one, so the URL stays whole and the phrase is refused as code.
 */
export const firstClause = (text: string) =>
  (
    text.split(
      /\s*(?:[,;]|:(?!\/\/)|\s[–—-]\s|\.\s|\.$|\?|!|\bsince\b|\bbecause\b|\bso that\b|\bso\b|\bthen\b|\bwhich\b|\bwhile\b|\bto see\b|\bto make sure\b|\bto check\b|\bto confirm\b|\bbut\b)\s*/
    )[0] ?? ""
  )
    .replace(/\s+/g, " ")
    .trim()

/** Words a whole phrase doesn't end on: what's left when a clause was cut short. */
const dangling = new Set([
  "a",
  "an",
  "the",
  "that",
  "how",
  "whether",
  "what",
  "which",
  "to",
  "and",
  "or",
  "but",
  "of",
  "with",
  "for",
  "from",
  "in",
  "on",
  "at",
  "by",
  "into",
  "my",
  "your",
  "its",
  "is",
  "are",
  "was",
  "were",
  "be",
  "it",
  "as",
  "than",
  "so",
  "if",
  "when",
  "where",
  "who",
  "this",
  "these",
  "those",
  "sits",
  "goes",
  "gets",
  "does"
])

/** Clean enough to show: no code, no machinery, nobody unclear ("them"), a whole phrase. */
export const presentable = (phrase: string) =>
  phrase.length >= 8 &&
  !dangling.has((phrase.split(" ").at(-1) ?? "").toLowerCase()) &&
  !/\b(they|them|they're|he|she|him|her)\b/i.test(phrase) &&
  phrase.split(" ").length >= 2 &&
  !codeLike.test(phrase) &&
  !machinery.test(phrase) &&
  !/\b(I|I'm|I've|I'll|me|my)\b/.test(phrase.replace(/^\w+ing\b/, ""))

/**
 * An imperative ("Run the scorer tests", "Scaffold web package and install deps") as an -ing phrase. Verbs after
 * "and" turn too. Undefined when it doesn't start with a verb, or only looks around.
 */
export const fromImperative = (text: string): string | undefined => {
  const clean = firstClause(text.replace(/\s\+\s/g, " and ").replace(/\.$/, ""))
  const [first, ...rest] = clean.split(" ")
  if (first === undefined) return undefined
  const verb = first.toLowerCase()
  if (!verbs.has(verb) || lookingAround.has(verb)) return undefined
  const turned = rest.map((word, i) => (rest[i - 1] === "and" && verbs.has(word.toLowerCase()) ? gerund(word) : word))
  return capitalize(toThem([gerund(verb), ...turned].join(" ")))
}

/** Deliberation, not work: "I'm weighing…", "I'm not sure…". */
const musing = new Set([
  "thinking",
  "noting",
  "wondering",
  "weighing",
  "guessing",
  "noticing",
  "considering",
  "not",
  "stuck",
  "unsure",
  "realizing",
  "seeing",
  "trying",
  "going",
  "about",
  "still",
  "now",
  "also",
  "glad",
  "done",
  "back",
  "pretty",
  "fairly",
  "confident",
  "worried",
  "hoping",
  "leaning",
  "assuming",
  "suspecting",
  "torn"
])

/** Words ending in -ing that aren't verbs. */
const notVerbs = new Set([
  "everything",
  "something",
  "nothing",
  "anything",
  "thing",
  "things",
  "string",
  "strings",
  "morning",
  "evening",
  "during",
  "ceiling",
  "king",
  "ring",
  "spring",
  "wing",
  "sibling",
  "bring"
])

/**
 * A sentence of the model's thinking or narration as an -ing phrase, when it says what it's doing:
 * "I'm setting up X…", "Now I'm writing X", "I'm going to check X", "I'll move X", "Let me fix X",
 * "Publishing the app.", or Codex's bold summary heading ("**Tightening the threshold**").
 */
export const fromSentence = (text: string): string | undefined => {
  const heading = /^\*\*(.+?)\*\*/.exec(text.trim())
  const sentence = heading !== null ? heading[1]! : (text.trim().split(/(?<=[.!?])\s+/)[0] ?? "")
  const body = sentence.replace(/^(now|next|first|so|ok(ay)?|right|then|alright),?\s+/i, "")
  let phrase: string | undefined
  let match: RegExpExecArray | null
  if ((match = /^I'm (?:going to|about to) (\w+)\b(.*)$/i.exec(body)) !== null) {
    phrase = verbs.has(match[1]!.toLowerCase()) ? `${gerund(match[1]!)}${match[2] ?? ""}` : undefined
  } else if ((match = /^I'm (\w+ing)\b(.*)$/i.exec(body)) !== null) {
    phrase = musing.has(match[1]!.toLowerCase()) ? undefined : `${match[1]}${match[2] ?? ""}`
  } else if ((match = /^(?:I'll|I will|Let me|I need to|I want to) (\w+)\b(.*)$/i.exec(body)) !== null) {
    phrase = verbs.has(match[1]!.toLowerCase()) ? `${gerund(match[1]!)}${match[2] ?? ""}` : undefined
  } else if ((match = /^([A-Z][a-z]+ing)\b(.*)$/.exec(body)) !== null) {
    const word = match[1]!.toLowerCase()
    phrase = musing.has(word) || notVerbs.has(word) ? undefined : `${match[1]}${match[2] ?? ""}`
  }
  if (phrase === undefined) return undefined
  const clause = firstClause(phrase)
  const [verb, ...rest] = clause.split(" ")
  if (verb === undefined) return undefined
  const lead = verb.toLowerCase()
  if (lookingAround.has(lead.replace(/ing$/, "")) || lead === "looking" || lead === "reading") return undefined
  return capitalize(toThem([verb, ...rest].join(" ")))
}

/** Shorter forms of a phrase that's too wide: dropping trailing "for/in/with/on/from/of …" phrases, one at a time. */
export const shorter = (phrase: string): ReadonlyArray<string> => {
  const forms: Array<string> = []
  let current = phrase
  while (true) {
    const cut = current.match(
      /^(.*\S)\s+(?:for|in|with|on|from|into|against|using|across|through|at|by|via|of)\s+\S.*$/
    )
    if (cut === null || cut[1] === undefined || cut[1].split(" ").length < 2) break
    current = cut[1]
    forms.push(current)
  }
  return forms
}
