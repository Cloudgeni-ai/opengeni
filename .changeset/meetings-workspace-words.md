---
"@opengeni/contracts": minor
"@opengeni/api-router": minor
"@opengeni/react": minor
---

Meetings: a workspace can list names and words every meeting transcript listens for, such as people, customers, products and trade terms ("Words to listen for" in meeting settings, `recordings.keyterms` in workspace settings). A recording's own keyterms come first, each word is sent once, and the list stops at the 100 a request takes. Re-runs use the list as it is then. Desktop dictation's vocabulary uses the same shared field.
