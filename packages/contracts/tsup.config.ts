import { defineConfig } from "tsup";

// @opengeni/contracts ships ESM + .d.ts. Its declared runtime dependencies
// stay external so consumers can deduplicate their schema and hashing runtimes.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/atlassian.ts",
    "src/canonical-human-identities.ts",
    "src/connection-authority.ts",
    "src/connector-attachments.ts",
    "src/connector-destinations.ts",
    "src/google-drive.ts",
    "src/managed-auth-session-sets.ts",
    "src/personal-github.ts",
    "src/slack-bot-scopes.ts",
    "src/editable-artifacts.ts",
    "src/editable-artifact-committed-transaction.ts",
    "src/editable-artifact-serialized-commit.ts",
    "src/editable-artifact-live.ts",
    "src/editable-artifact-causal-frontier.ts",
    "src/editable-artifact-codec-registry.ts",
    "src/editable-artifact-versions.ts",
    "src/spreadsheet-artifact-commands.ts",
    "src/spreadsheet-artifact-query.ts",
    "src/document-artifact-commands.ts",
    "src/document-artifact-query.ts",
    "src/presentation-artifact-commands.ts",
    "src/presentation-artifact-query.ts",
    "src/codex-provider-account-authority.ts",
    "src/video-generation.ts",
    "src/xai-provider-account-authority.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
});
