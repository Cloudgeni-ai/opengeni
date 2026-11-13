---
"@opengeni/react": patch
---

The Connect card keeps showing a connection as done after a reload or account switch when the chat already uses it, and setup card results tell the agent the chat continues on its own once the person finishes.

- A prepared key setup (an agent's proposed MCP server) now lets the agent continue the request once it is connected, as other setup cards do.
- A confirmation dialog opened from a form field (such as "Make this person a workspace admin?" in Add people) no longer also submits the form behind it, which added the person with the role chosen before the confirmation.
- When a Site conversation starts waiting for the person, such as an approval from the Site's own `ai.run`, the Site's chat panel opens it.
