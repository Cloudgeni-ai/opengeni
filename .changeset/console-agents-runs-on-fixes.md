---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"opengeni": minor
---

Organization agent Runs on is checked where a chat finally lands: a Personal (Only me) machine is refused whether the request names it, a default would pick it or a worker would join its parent's box on it, a person's own default machine is not used for organization agent chats, and a machine the caller can't read is refused as unavailable. A version now keeps the id of the machine or Sandbox Environment its `runsOn` named when it was saved (migration 1510 adds `agent_revisions.runs_on_target`), so renaming one, or adding another with the same name, no longer moves or breaks the agent; the written name stays for display and YAML. The reach dialog's "All product-managed workspaces" option says that every end customer's chats share the machine. Clients that predate `allowManagedWorkspaces` keep it unchanged when they narrow a machine's or environment's workspaces, so turn it off in Console or with a current SDK.
