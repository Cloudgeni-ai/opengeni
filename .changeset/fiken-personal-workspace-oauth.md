---
"@opengeni/api-router": patch
"@opengeni/core": patch
---

Fiken, the Opengeni Slack bot and X/Reddit "Connect only for me" now connect in a person's own Personal workspace. A Personal workspace has no workspace membership row, so an OAuth callback finds its owner only through the signed personal-owner claim. The Fiken and Slack bot start routes never signed that claim, and the X/Reddit callback started from a chat re-checked with a plain membership lookup, so all three refused the owner after the provider consent screen (Fiken returned `fiken=error&reason=callback_failed`, the Slack bot `slack=error`, X/Reddit `not_authorized`).

Every OAuth/install start that names its owner now signs the owner fields through one helper whose claim argument is required. The owner type that callbacks re-check makes the claim required too, so leaving it out no longer compiles. Every callback re-checks its owner through the shared authority check instead of a bare membership lookup, and a source test keeps new connectors on both paths. Ownership is unchanged: Fiken and the Slack bot stay workspace-owned, and X/Reddit "Connect only for me" stays personal. Because the chat-started X/Reddit callback now uses that shared check, it also accepts a workspace connection started with an API key, as the Connect flow already did.

A Fiken or Slack bot state signed before this change carries no claim, so it is still refused in a Personal workspace; restart the connection after the upgrade. Shared workspaces are unaffected.
