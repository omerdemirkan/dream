import { defineConfig } from "vitest/config"

// The data layer (services, the fake backend, reducers, formatting) runs in
// Node. Screens and native modules are checked in the iOS Simulator instead.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
})
