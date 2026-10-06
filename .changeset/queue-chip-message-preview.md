---
"@opengeni/react": patch
---

The collapsed queue chip in `SessionChrome` now shows the text of the latest queued message beside its Steer action, so a message sent while the agent is working is visible without opening the queue. That Steer now sends the message it shows (the latest) instead of the first in line. In the open queue list, every row keeps Steer visible; move, edit and delete still appear on hover.
