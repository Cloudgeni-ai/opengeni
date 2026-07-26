import { defineConfig } from "tsup";

// @opengeni/agent-proto ships ESM + .d.ts. Its only runtime dependency is
// @bufbuild/protobuf (the ts-proto wire runtime), which stays external so
// consumers dedupe it.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
});
