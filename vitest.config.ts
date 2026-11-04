import { defineConfig } from "vitest/config"

// Each listed directory is its own Vitest project (named after its package.json).
// A package that needs a different environment adds its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: [
      "packages/domain",
      "packages/agent-context",
      "packages/dreamd",
      "packages/sandbox-template",
      "apps/api",
      "infra"
    ],
    passWithNoTests: true
  }
})
