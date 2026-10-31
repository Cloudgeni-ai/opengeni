---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/react": patch
---

A person's own (Only me) logins work for their messages where they turned them on. In their Personal workspace every own login works; in a shared workspace a login works once its owner turns it on there. A login starts on in the workspace it was added from, and connecting or reconnecting the same account from another shared workspace turns it on there too. Logins that existed before start on in every shared workspace their owner belongs to, so nothing that worked stops working.

When a chat asks for a connector whose login the person added in another workspace, the Connect card offers it with one click ("Use it here") instead of a new sign-in. Each own login on a connector's Capabilities page has a "Use for my messages here" switch. In a chat shared with the workspace, the owner sees a one-line note that their logins work for their messages there and that people in the workspace see what the agent does with them, with "Stop using it here"; it never blocks a turn.

Being turned on is a standing personal-resource grant: user-resource kind `connection` with action `connection.use`, issued with mode `always` and context `workspace_shared` and revoked like any other grant; other modes are refused for logins. `ConnectionMetadata` gains `turnedOnHere` and `turnedOnHereGrantId` on a person's own accounts. Logins that are off in a workspace are not attached to turns there. Personal GitHub keeps its own per-chat repository choice.
