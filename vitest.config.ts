import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      // The oracle's drift test: `SWIFT_PLAN.md` depends on the committed vectors still matching
      // the implementation they were recorded from.
      "tools/*/test/**/*.test.ts",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});
