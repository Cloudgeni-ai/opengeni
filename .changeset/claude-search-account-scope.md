---
"@opengeni/runtime": patch
---

Fix Claude conversations failing with "Invalid `encrypted_content` in `search_result` block" after they move to another Claude account. Anthropic encrypts web search results for the account that ran the search, so a conversation that later ran on a different account (an exhausted account in a subscription pool, a replaced key) was rejected on every turn. Each stored search now records an opaque account scope (the Claude account UUID, or a one-way digest of the API key) and is replayed natively only to that same account; on any other account, and for searches stored before this change, it is sent as readable facts (query, titles, URLs) without encrypted data or citations. Searches still continue natively within a turn, including paused turns, and the request prefix stays stable while the conversation stays on one account.
