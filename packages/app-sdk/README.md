# `@opengeni/app-sdk`

Typed, dependency-free browser bridge for OpenGeni Apps running in a sandboxed
iframe.

The host creates a `MessageChannel`, transfers exactly one port to the app, and
binds that channel to an unpredictable run token. The iframe never receives a
parent DOM handle, browser storage, OpenGeni credentials, or a general-purpose
`postMessage` listener after connection. Capability calls are rejected locally
unless the human confirmed that capability for the current run.

Hosts must choose an explicit bridge delivery mode. Exact-origin frames use an
HTTP(S) origin. Opaque sandbox frames use the dedicated `opaque_sandbox` mode,
which targets the exact iframe `WindowProxy` and transfers the private channel
with wildcard delivery because browsers expose those frames with a `null`
origin. Arbitrary caller-provided wildcard origins are not accepted.

Inside an app:

```ts
import { installOgGlobal } from "@opengeni/app-sdk";

const og = await installOgGlobal();
const context = await og.getContext();
const result = await og.invokeTool("status.read", { service: "api" });
```

Build-generated `og.tools.*` declarations use each catalog entry's canonical
`programmaticPath`. The bridge sends that dotted path only as a capability
selector; the host resolves it back to the opaque canonical tool identity
before dispatch. Apps never derive authority by parsing a display or model
name.

The stock OpenGeni web product uses `createOgAppHostBridge` and forwards allowed
capability calls through an injected Apps control transport. This package does
not choose HTTP routes, Code Mode tools, credentials, or persistence.