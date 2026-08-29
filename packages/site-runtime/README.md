# @opengeni/site-runtime

Credential-free browser SDK for a static SPA running inside an authenticated
OpenGeni Site shell.

```ts
import { connect } from "@opengeni/site-runtime";

const site = await connect();
const receipt = await site.ai.start({ message: "Summarize the approved data" });

site.onEvent(({ sessionId, event }) => {
  if (sessionId === receipt.sessionId) console.log(event);
});
```

The package talks only to the page-lifetime `MessageChannel` supplied by the
OpenGeni shell. It has no network client and accepts no credential. Model,
instruction, integration, approval, access, and budget authority comes from the
immutable Site release and is enforced by the parent gateway.
