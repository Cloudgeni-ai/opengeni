import { defineConfig } from "tsup";

// @opengeni/capabilities ships one ESM entry point. Keep workspace packages
// and its protocol/runtime dependencies external so consumers deduplicate them.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//, /^@openai\/agents(?:$|\/|-)/, /^graphql$/, /^js-yaml$/],
});
