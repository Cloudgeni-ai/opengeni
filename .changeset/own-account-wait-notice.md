---
"@opengeni/react": patch
"@opengeni/api-router": patch
---

A turn someone else started (such as meeting notes) that waits for Codex usage in your Personal workspace now says it can't use your own ChatGPT account, and offers "Continue on my account" when that account has room. The button takes over the wait as you, also after you paused the chat.

A ChatGPT account that Opengeni saw used no longer reads "No usage yet". When a live usage check returns no windows (for example a personal account the viewer can't read live), the Codex overview keeps the saved reading, and list rows show an older reading with its age ("Checked 16 hours ago"), or "No recent reading" when none is left.
