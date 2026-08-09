import { defineConfig } from "tsup";

// @opengeni/contracts ships ESM + .d.ts. Its declared runtime dependencies
// stay external so consumers can deduplicate their schema and hashing runtimes.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/connector-destinations.ts",
    "src/google-drive.ts",
    "src/slack-bot-scopes.ts",
    "src/editable-artifacts.ts",
    "src/editable-artifact-committed-transaction.ts",
    "src/editable-artifact-serialized-commit.ts",
    "src/editable-artifact-live.ts",
    "src/editable-artifact-causal-frontier.ts",
    "src/editable-artifact-codec-registry.ts",
    "src/spreadsheet-artifact-commands.ts",
    "src/spreadsheet-artifact-query.ts",
    "src/document-artifact-commands.ts",
    "src/document-artifact-query.ts",
    "src/presentation-artifact-commands.ts",
    "src/presentation-artifact-query.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
});
