---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

The workspace filesystem layout and the agent's sandbox manifest now come from one builder and one placement rule. `buildManifest` takes the turn's placement (`activeSandboxBackend`, `sandboxWorkspaceRoot`) and owns the Connected Machine root and resource rules; the layout is that manifest without files. The SDK renders nothing from the manifest into the system prompt (`manifestInstructions: false` replaces the `instructionManifest` projection and `filesystemInstructions`), so a resumed sandbox that still holds an earlier turn's file mount at a custom path no longer adds a remote mount policy section to the cached system prompt. Rendered text for every other case is unchanged.
