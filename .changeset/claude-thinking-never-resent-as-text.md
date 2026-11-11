---
"@opengeni/runtime": patch
---

Claude's own thinking from an earlier turn is no longer resent as readable "[Historical reasoning from another model]" assistant text when it can't go back natively (after a system prompt, account, model or transport change, or after Claude refused the signature). It is left out instead, as Claude itself does with a block whose binding no longer matches. Shown back to Claude as text, its own reasoning could trip Claude's safety systems, which refused the whole request and every retry, so affected chats failed with "Claude blocked this request through its safety systems". An assistant message that held only such thinking is removed, and the messages around it are joined. Reasoning from other providers still reaches Claude as readable text.
