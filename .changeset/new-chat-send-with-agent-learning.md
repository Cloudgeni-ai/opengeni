---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

A new chat whose draft has an Agent learning setting can be sent again. The composer saved Agent learning in the new-chat draft, but the server's check that Send matches the saved draft left it out, so every such Send was refused as a draft conflict and the person was told the draft kept changing in another tab. The check now compares every option a new-chat draft can hold, taken from the draft contract itself, and treats an Agent learning setting with nothing overridden as unset. The composer names another tab or window only when the draft really changed since its Send saved it; otherwise it stops retrying and says the message couldn't be sent.
