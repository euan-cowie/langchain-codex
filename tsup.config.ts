import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: false,
  external: ["@langchain/core", "@openai/codex-sdk", "zod"],
});
