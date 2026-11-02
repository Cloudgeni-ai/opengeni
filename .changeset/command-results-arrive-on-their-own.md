---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
---

Background commands that finish while the agent is working now report themselves. Their exit status and the start and end of their output follow the agent's next plain-text tool result (including `apply_patch` edits), and are recorded as read exactly like a terminal `command_read`, so the same result is never delivered again. The agent no longer spends a `command_read` only to learn that a command finished. The `background_command_result` input that wakes a waiting session, or reaches its next turn, now carries the same bounded output, so that turn needs no extra read either. Earlier history never changes, JSON and image tool results are left as they were, and results not delivered during a turn still arrive as ordinary input. The timeline keeps showing each tool's own output. Results only use the room a tool's own output leaves in the model's tool-output budget, and are masked for known secret values. `OPENGENI_EXPERIMENT_CUT_POLLING=false` turns the in-turn delivery off, along with the prompt sentence that tells the agent not to poll.
