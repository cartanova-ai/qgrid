import { defineConfig } from "vitest/config";

// These files include real model/transaction tests; keep them in the DB suite.
export const databaseTests = [
  "src/application/setting/setting.persistence.test.ts",
  "src/application/token/token.model.test.ts",
  "src/application/request-log/request-log.model.test.ts",
];

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: databaseTests,
    restoreMocks: true,
    maxWorkers: 4,
    coverage: { provider: "v8", reportsDirectory: "coverage/unit" },
  },
});
