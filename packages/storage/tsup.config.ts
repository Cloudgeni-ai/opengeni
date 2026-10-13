import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/provider-sdk-s3.ts",
    "src/provider-sdk-azure.ts",
    "src/provider-sdk-gcs.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  // Published ESM also runs under Node; source/release Bun builds recognize the
  // literal require calls and bundle their provider modules conditionally.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  clean: true,
  external: [/^@opengeni\//, /^\.\/provider-sdk-(?:s3|azure|gcs)\.js$/],
});
