---
"@opengeni/core": patch
---

A new chat no longer starts on a model that was removed from the deployment catalog. When the model a person last picked for new chats is no longer listed for the workspace (its provider was removed or the model retired), the new-chat form follows the workspace default again until they pick another model. A model that is still listed but temporarily unavailable keeps the person's choice, and a catalog read failure never discards it.
