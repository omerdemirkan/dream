/**
 * The order each prompt's sections are joined in. A prompt is a directory under docs/prompts/ and each section a
 * markdown file in it, named here without `.md`. A new section goes into its directory and into this list where it
 * reads best; the drift test fails on a file that's in one and not the other. docs/prompts/README.md maps them all.
 */
export interface PromptLayout {
  /** The directory under docs/prompts/. */
  readonly dir: string
  /** Its heading in the map. */
  readonly title: string
  /** Where the prompt ends up, for the map. */
  readonly role: string
  /** A file in `dir` holding the prompt's own YAML frontmatter, emitted first between `---` lines (a skill's). */
  readonly frontmatter?: string
  readonly sections: ReadonlyArray<string>
}

/** The two system prompts. */
export const prompts = {
  systemPrompt: {
    dir: "system",
    title: "System prompt",
    role: "The system prompt of the project's agent, for every turn (`systemPrompt`).",
    sections: [
      "opening",
      "person",
      "what-they-see",
      "writing-to-them",
      "workstreams",
      "apps-speak",
      "success",
      "where-you-are",
      "machine",
      "sleep-and-wake",
      "running-on-its-own",
      "once-its-live",
      "orchestrating",
      "step-cost",
      "subagent-models",
      "reviewing",
      "offering-versions",
      "credentials",
      "usage"
    ]
  },
  taskPrompt: {
    dir: "task",
    title: "Task prompt",
    role: "The system prompt of a scheduled task's session, `dream wake --task` (`taskPrompt`).",
    sections: ["opening", "on-your-own", "nobody-watching", "reaching-them", "report", "sandbox"]
  }
} as const satisfies Record<string, PromptLayout>

export type PromptName = keyof typeof prompts

/**
 * Dream's skills, each a directory under docs/prompts/skills/ named as the skill, with its frontmatter (name and
 * description) in `frontmatter.yaml`. The agent and every task's session get all of them, in this order, but for
 * `dream-openai`, which they get only while Dream's AI gateway is on.
 */
export const skillSections = {
  "dream-chat": ["chat", "messages", "email", "questions", "threads", "status", "workstreams", "live-activity"],
  "dream-access": ["access"],
  "dream-hosting": ["hosting", "relays", "if-it-grows"],
  "dream-wake": ["waking", "recurring-work"],
  "dream-notify": ["notify"],
  "dream-links": ["links"],
  "dream-machines": ["machines", "machine", "browsers", "mac"],
  "dream-usage": ["usage"],
  /** Only while Dream's AI gateway is on: dreamd leaves it out otherwise (`packages/dreamd/src/harness/Skill.ts`). */
  "dream-openai": ["gateway"]
} as const satisfies Record<string, ReadonlyArray<string>>

export type SkillName = keyof typeof skillSections

export const skillLayout = (name: SkillName): PromptLayout => ({
  dir: `skills/${name}`,
  title: `The \`${name}\` skill`,
  role:
    "A skill (`SKILL.md`): the harness lists its name and description on every turn, and the agent or a task's " +
    "session reads the rest when it judges it needs it.",
  frontmatter: "frontmatter.yaml",
  sections: skillSections[name]
})

export const skillNames = Object.keys(skillSections) as Array<SkillName>
