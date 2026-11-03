---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

Only the owner of a personal (Only me) login can approve an action that runs on it. An approval runs on the accounts its message froze, so before this any member, workspace API key or Slack click by someone else could make an action happen as another person. The owner's personal API key and `asUser` tokens count as the owner. Approving such an action as anyone else now answers 403 `APPROVAL_REQUIRES_ACCOUNT_OWNER` with a message naming who can approve; declining stays open to anyone who can control the chat, and actions on workspace logins keep their ordinary rules. A tool review adds the optional `approvedBy` ("you" or "account_owner") and `accountOwnerLabel` fields, and the review card says who can approve, or tells the owner in a shared chat that the decision is theirs.
