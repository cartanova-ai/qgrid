import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  dts: true,
  clean: true,
  deps: {
    neverBundle: ["ai", "@ai-sdk/provider", "@ai-sdk/provider-utils", "undici", "zod"],
  },
  fixedExtension: false,
  format: "esm",
});
