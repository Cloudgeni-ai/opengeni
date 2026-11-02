---
"@opengeni/desktop": patch
---

The dictation pill and the meeting card no longer stop appearing after their page's process is killed or hangs, for example when the system reclaims memory. A window whose page is gone, hangs, fails to render or doesn't answer within five seconds is thrown away and built again (once) showing the current state, and the failure is logged instead of being swallowed. `DictationHud` and `MeetingPromptCard` take an optional `log`.
