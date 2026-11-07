/**
 * How the prompt strings are cut from the docs. Shared by the sync script and
 * the drift test so both agree.
 */
/** docs/agent-context.md and docs/task-context.md are a short note for humans, a `---` line, then the prompt. */
const promptBody = (file: string, markdown: string) => {
  const lines = markdown.split("\n")
  const rule = lines.findIndex((line) => line.trim() === "---")
  if (rule === -1) throw new Error(`${file}: expected a \`---\` line before the prompt body`)
  return (
    lines
      .slice(rule + 1)
      .join("\n")
      .trim() + "\n"
  )
}

export const extractPrompts = (docs: {
  readonly agentContext: string
  readonly dreamSkill: string
  readonly taskContext: string
}) => ({
  systemPrompt: promptBody("docs/agent-context.md", docs.agentContext),
  dreamSkill: docs.dreamSkill.trim() + "\n",
  taskPrompt: promptBody("docs/task-context.md", docs.taskContext)
})
