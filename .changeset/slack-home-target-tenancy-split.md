---
"@opengeni/db": patch
---

Split the Slack integration's single workspace identifier into two explicit scopes: home (the installation binding that owns the bot credential, the inbox row, the identity link, and the post ledgers) and target (the workspace that owns the interaction, its action handles, the grant, and the session). The two are equal today, so behaviour is unchanged. Thread continuation is now connection-scoped through the content-free tenancy probe, interaction creation adopts an existing thread's tenancy instead of failing an idempotency conflict, delivery builds its bot client from the installation route, and the first-task hint resolves its identity claim and its frozen answer in the scope that owns each.
