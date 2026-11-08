/**
 * The order each prompt's sections are joined in. A prompt is a directory under docs/prompts/ and each section a
 * markdown file in it, named here without `.md`. A new section goes into its directory and into this list where it
 * reads best; the drift test fails on a file that's in one and not the other. docs/prompts/README.md maps them all.
 */
export interface PromptLayout {
  /** The directory under docs/prompts/. */
  readonly dir: string
  /** Where the prompt ends up, for the map. */
  readonly role: string
  /** A file in `dir` holding the prompt's own YAML frontmatter, emitted first between `---` lines (the skill's). */
  readonly frontmatter?: string
  readonly sections: ReadonlyArray<string>
}

export const layout = {
  systemPrompt: {
    dir: "system",
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
      "usage",
      "recurring-work",
      "if-it-grows"
    ]
  },
  dreamSkill: {
    dir: "skill",
    role: "The `dream` skill (`SKILL.md`), which the agent and every task's session load when they need it (`dreamSkill`).",
    frontmatter: "frontmatter.yaml",
    sections: [
      "dream",
      "messages",
      "email",
      "questions",
      "access",
      "app-notifications",
      "status",
      "workstreams",
      "threads",
      "live-activity",
      "waking",
      "hosting",
      "relays",
      "app-links",
      "browsers",
      "mac",
      "machine",
      "usage"
    ]
  },
  taskPrompt: {
    dir: "task",
    role: "The system prompt of a scheduled task's session, `dream wake --task` (`taskPrompt`).",
    sections: ["opening", "on-your-own", "nobody-watching", "reaching-them", "report", "sandbox"]
  }
} as const satisfies Record<string, PromptLayout>

export type PromptName = keyof typeof layout
