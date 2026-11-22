---
"@opengeni/react": patch
---

**Add trigger** now sets up a Linear, Sentry or Tailscale webhook in place: it creates the webhook URL to paste into the app, then takes the secret the app shows in one field with **Save secret**. The secret is sent once, stored only on the server and never shown again; the dialog then says the secret is set, with **Replace**. A webhook still waiting for its secret can be picked to paste it. Gmail and MCP sources keep their Add a source step.
