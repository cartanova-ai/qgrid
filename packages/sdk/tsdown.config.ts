import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  target: "node20",
});
