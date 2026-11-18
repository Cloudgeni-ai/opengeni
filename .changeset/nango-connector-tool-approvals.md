---
"@opengeni/core": patch
---

Per-tool approvals work for connectors served through Nango. A connector's approvals page now resolves accounts with the same integration backend switch a session runs with, so a Gmail, Calendar or Drive account connected through Nango is the account its approvals are managed for, instead of the page asking to connect an account. Choices are stored for that account and apply to its calls, exactly as for a native account. A Personal workspace also carries a connector its owner connected through Nango in another workspace, as it does for a native account.
