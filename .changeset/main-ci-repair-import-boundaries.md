---
"@opengeni/react-native": patch
"@opengeni/runtime": patch
---

`useOpenNativeLink` moves to its own module so the native environment module no longer imports `react-native` at runtime, and the API derives the session MCP permission identity through the approved `@opengeni/runtime/workspace-tool-gateway` entrypoint instead of the runtime barrel.
