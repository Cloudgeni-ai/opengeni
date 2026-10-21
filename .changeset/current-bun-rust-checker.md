---
"@opengeni/agent-proto": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/vaults-protonpass": patch
---

Upgrade the Bun runtime, bundler, test runner and package-manager pins to 1.4.3,
and use exact-pinned tsrs for CLI typechecks while retaining stable TypeScript
for declaration emission and editor/tooling compatibility. Preserve strict
protobuf partial-constructor checks under TypeScript 7.1 without changing the
wire codec, and make existing source annotations compatible with the new checker.
Regenerate the checked-in Site browser runtime with the pinned Bun bundler.
