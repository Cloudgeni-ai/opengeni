---
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/react-native": patch
---

Approvals waiting in the inbox and in phone and desktop notifications now say what the action does and where it runs ("Move 3 messages to Trash", Gmail) instead of the raw tool name ("batch_modify_messages"). A pending approval's `display.title` is set to the same title its review card shows, an inbox approval's `body` names the integration (and the account when there are several), and the push reads "Needs your approval: … (Gmail)". The inbox shows that integration in the row's details line instead of a code chip.
