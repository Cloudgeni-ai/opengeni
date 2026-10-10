---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Long orchestration runs no longer stack identical "Agent update / Worked for / Waited" rows. Two or more consecutive quiet cycles (routine input, work without a visible reply, a finished wait) fold into one row such as "8 updates over 5h 54m · 30 steps", with the latest wait reason under it on the web. Expanding it shows the original rows unchanged. Visible replies, people's messages and the turns they open, failed turns, approvals, live work and the current wait are never folded.
