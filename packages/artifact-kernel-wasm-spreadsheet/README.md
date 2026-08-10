# `@opengeni/artifact-kernel-wasm-spreadsheet`

Exact, capability-scoped WebAssembly runtime for the OpenGeni spreadsheet editor.
It is generated from the safe Rust artifact kernel and loaded only in the SDK's
dedicated module Worker. It performs no runtime download or version discovery.

```ts
import { editableArtifactKernelRuntime } from "@opengeni/artifact-kernel-wasm-spreadsheet";
```

Pass the runtime into `@opengeni/sdk/editable-artifacts`; the Worker verifies
its exact build/protocol/model/command identity before loading artifact state.
