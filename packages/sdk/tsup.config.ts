import { defineConfig } from "tsup";

// @opengeni/sdk ships ESM + .d.ts. Its ordinary surfaces hand-mirror the public
// wire types (pinned by test/contract-parity.test.ts); only the opt-in editable
// artifact entries import canonical bounds/codecs from @opengeni/contracts.
//
// Every @opengeni/* specifier stays external except the dependency-free,
// client-safe session-title policy leaf. Bundle that exact leaf so browser
// display titles and durable titles share one implementation without making
// the contracts package runtime reachable from the ordinary SDK root. Keeping
// every other workspace edge external remains load-bearing for the publish
// closure guard: a stray server import stays visible in dist.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/accounts.ts",
    "src/core.ts",
    "src/browser.ts",
    "src/document-authority.ts",
    "src/artifacts.ts",
    "src/memory-slack.ts",
    "src/automations.ts",
    "src/pr-review.ts",
    "src/organization-private-session-settings.ts",
    "src/organization-user-setup.ts",
    "src/realtime.ts",
    "src/editable-artifacts.ts",
    "src/editable-artifacts-worker.ts",
    "src/interaction.ts",
    "src/session.ts",
    "src/codex-realtime-controller.ts",
    "src/gateway-realtime-transport.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
  noExternal: ["@opengeni/contracts/session-titles"],
});
