---
---

Sandbox: a chat whose sandbox setup was cut off mid-start no longer stays "recovering" forever once its box has been shut down. The reaper checks the exact old box with the provider and, when it is confirmed terminated, the chat retries its setup. Running or missing boxes, other boxes, and paused chats are left alone, and nothing is replayed. Chats already stuck this way recover automatically after the upgrade.
