---
"@opengeni/db": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Add the agent-facing `company_profile_propose` first-party MCP tool over a new `proposeCompanyProfile` seam: an exact agent attempt records one inactive organization company-profile proposal (durable-learning provenance, `agent-attempt:<attemptId>` source) that an organization account admin reviews and activates from Company Brain → Company profile & goals, which now lists pending proposals with their content.
