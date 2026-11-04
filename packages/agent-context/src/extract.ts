/**
 * How the prompt strings are cut from the docs. Shared by the sync script and
 * the drift test so both agree.
 */
export const extractPrompts = (docs: { readonly agentContext: string; readonly dreamSkill: string }) => {
  // docs/agent-context.md is a short note for humans, a `---` line, then the prompt.
  const lines = docs.agentContext.split("\n")
  const rule = lines.findIndex((line) => line.trim() === "---")
  if (rule === -1) throw new Error("docs/agent-context.md: expected a `---` line before the prompt body")
  return {
    systemPrompt:
      lines
        .slice(rule + 1)
        .join("\n")
        .trim() + "\n",
    dreamSkill: docs.dreamSkill.trim() + "\n"
  }
}
