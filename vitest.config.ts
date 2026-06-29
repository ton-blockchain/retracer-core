import {defineConfig} from "vitest/config"

export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["**/*.{test,spec}.ts"],
  },
})
