---
---

Deleting a chat no longer stops it when the refusal is permanent. The API now returns a structured `details.code` for each delete refusal (`session_delete_active_sessions`, `session_delete_externally_referenced`, ...), and the web app only stops-and-retries while the chat is still running. Before, a chat with saved outputs or forks was cancelled and then still not deleted.
