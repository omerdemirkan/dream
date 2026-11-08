/**
 * Dream's skills as the harness wants them. The canonical text (the sections in `docs/prompts/skills/<name>/`) is
 * built into a SKILL.md with frontmatter for each; the harness writes SKILL.md itself from a name, a description and
 * the body, for Claude Code (`~/.claude/skills/<name>/`) and Codex (`~/.agents/skills/<name>/`), and removes a skill
 * it wrote earlier that's no longer among them.
 */
import { skills } from "@dream/agent-context"
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

/** The skills from `@dream/agent-context`; they always parse (a test checks), so a failure is a bug. */
export const all: Effect.Effect<ReadonlyArray<Skill>> = Effect.suspend(() =>
  Effect.forEach(skills, (markdown) =>
    Option.match(parseSkill(markdown), {
      onNone: () => Effect.die(new Error("A skill in @dream/agent-context has no name or description")),
      onSome: Effect.succeed
    })
  )
)
