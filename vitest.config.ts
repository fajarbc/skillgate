import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // scripts/*.test.mjs use node:test, not Vitest. Run them separately with
    // node --test; collecting them here reports false "No test suite" errors.
    exclude: ["**/node_modules/**", "**/.git/**", "scripts/**/*.test.mjs"],
  },
});
