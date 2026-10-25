---
---

Agent only: a machine whose attached Chrome reconnected, or closed its connection, while a browser command was still waiting for an answer can update itself again. That command's answer can never arrive once its connection is gone, but the agent kept it as unfinished work, so the self-update waited for it forever.
