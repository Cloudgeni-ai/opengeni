---
"@opengeni/react": patch
---

A chat's sidebar row no longer shows the paused icon just because some of its sub-agents are paused. The pause mark now appears only when the chat itself is paused (its own parked turn, or its pause holding its workers' work). Running, needs-you, failed and other sub-agent states still surface on the parent as before, and paused workers stay listed in the row's hover card and on their own rows.
