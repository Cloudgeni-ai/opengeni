# `@opengeni/artifact-kernel-wasm-presentation`

Exact, capability-scoped WebAssembly runtime for the OpenGeni presentation editor.
It is generated from the safe Rust artifact kernel and loaded only in the SDK's
dedicated module Worker. It performs no runtime download or version discovery.

```ts
import { editableArtifactKernelRuntime } from "@opengeni/artifact-kernel-wasm-presentation";
```

Pass the runtime into `@opengeni/sdk/editable-artifacts`; the Worker verifies
its exact build/protocol/model/command identity before loading artifact state.
