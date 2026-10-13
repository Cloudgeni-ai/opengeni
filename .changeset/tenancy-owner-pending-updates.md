---
"@opengeni/db": patch
---

Let an idle chat become Only me when its only pending machine updates (finished background commands, child results, agent messages) carry the owner's own authority. Before, any pending update blocked the change with "must be fully quiescent", and idle chats keep those updates until their next turn, so they could never go private. Updates frozen with another person's connections, subscription authority or causal turn still block.
