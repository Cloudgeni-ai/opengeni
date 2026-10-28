---
"@opengeni/core": patch
---

An agent's machine list shows a computer once when one running agent serves two enrollments of it, such as its owner's own (Only me) enrollment and the same computer shared with the workspace. Both entries used to appear with the same name, so an agent could pick the personal one and ask its owner to allow the chat, although the shared one needed no permission. The list now keeps the entry the chat is already on, and otherwise the shared one. Enrollments served by different running agents are still listed separately.
