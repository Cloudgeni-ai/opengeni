---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

People who manage a Claude account can use one of its limit resets. `POST /v1/workspaces/:workspaceId/claude/accounts/:accountId/limit-resets/claim` (and the organization route) takes `{ grantId, requestId }`, claims the grant with Claude and returns Claude's answer with the usage read right after it (`ClaimClaudeLimitResetResponse`). When the answer is `retryable`, retry with the same `requestId`: Claude settles each request id once, so a retry never uses a second reset. The SDK adds `claimClaudeSubscriptionAccountLimitReset` and `claimOrganizationClaudeSubscriptionAccountLimitReset`. The account page shows a "Use reset" button on each grant that can be used now, behind a confirmation. Agents can use the same action, only when the person asked for it.
