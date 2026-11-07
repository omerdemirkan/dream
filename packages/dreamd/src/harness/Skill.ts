/**
 * The `dream` skill as the harness wants it. The canonical text (the
 * sections in `docs/prompts/skill/`) is built into a SKILL.md with frontmatter; the harness writes
 * SKILL.md itself from a name, a description and the body, for Claude Code
 * (`~/.claude/skills/dream/`) and Codex (`~/.agents/skills/dream/`).
 */
import { dreamSkill } from "@dream/agent-context"
import { Effect, Option } from "effect"

export interface Skill {
  readonly name: string
  readonly description: string
  readonly content: string
}

export const parseSkill = (markdown: string): Option.Option<Skill> => {
  const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(markdown)
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(match?.[1] ?? "")?.[1]?.trim()
  const name = field("name")
  const description = field("description")
  return match === null || name === undefined || description === undefined
    ? Option.none()
    : Option.some({ name, description, content: match[2] ?? "" })
}

/** The skill from `@dream/agent-context`; it always parses (a test checks), so a failure is a bug. */
export const dream: Effect.Effect<Skill> = Effect.suspend(() =>
  Option.match(parseSkill(dreamSkill), {
    onNone: () => Effect.die(new Error("The dream skill in @dream/agent-context has no name or description")),
    onSome: Effect.succeed
  })
)
