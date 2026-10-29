---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

Google Drive and Atlassian connections now record which account they belong to. Connecting the same account again reuses the existing connection, a different account can be added alongside it, and both are labelled with the account's email. Before, a second Drive or Atlassian account was refused because the account could not be told apart. An existing Drive or Atlassian connection needs one reconnect before a second account can be added.
