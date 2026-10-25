---
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Agents can now find the deployment's reviewed Microsoft integrations (Outlook Mail, Calendar and Contacts, OneDrive and Teams) by the names people use, including Hotmail, Live and MSN, and post a Connect card for them in chat. `SessionIntegrationCapabilityCard` connects the viewer's own personal account in one click (never a workspace account, and reconnecting an expired one, the most recently used one when there are several), installs the reviewed tools for that account, selects them for the chat, lets the agent continue the request, and shows Microsoft's administrator approval link when an organization requires it. It renders in the console and in `SessionConversation` / `OpenGeniChat`, including session-proxy embeds, for people who may connect their own accounts (`sessions:control` plus `connections:personal`, which per-user embed identities get by default). `attachSessionCapability` also accepts an installed integration's runtime server. `ApiIntegrationInstallationSummary` gains `connectionLastUsedAt`, and its `connected` is now true only while the bound connection is active.
