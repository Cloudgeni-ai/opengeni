---
"@opengeni/react": patch
---

In-chat connect cards read as the service for reviewed integrations. The line under the name shows the provider ("Google") instead of a host name such as `calendarmcp.googleapis.com`, and a service without a logo shows its kind of content (a calendar or mail icon) or its word initials ("GC") instead of the first two letters of its name ("GO"). The setup dialog opens with the service's plain introduction and a short list of what the agent can do once connected, followed by one button. The host address, connection type, full catalog description and access summary move under a closed "Details" disclosure. Servers someone added by hand, and catalog entries nobody reviewed, keep their host name and "MCP server" label. `connectionCardSubtitle` is exported from `@opengeni/react/in-chat-connect-model` so other renderers can make the same choice.
