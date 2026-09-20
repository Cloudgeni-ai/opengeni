---
"@opengeni/db": patch
---

Allow Codex subscription-source changes while work is active. Preserve accepted
turns' original source through credential leasing, recovery, and capacity waits,
while new work uses the workspace's selected source. Connecting a workspace
subscription no longer overwrites an explicit source preference. Workspace
connection controls remain available while inheriting organization subscriptions.