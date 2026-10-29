---
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

The chat beside a Site in the console's Site view is now the regular chat: the same composer, messages and status row as a chat on its own page, without the session panel. Screenshots and files can be pasted or dropped into it (a drop anywhere on the chat, or on the Site beside it, attaches to the chat instead of going to the Site's frame), and it has the attach button, dictation, voice, the model chip, the queue and steer row, find and fork. A new conversation started there uses the regular composer too, including attachments and voice-first start. The chat can move to the left of the Site from its ⋯ menu (Move chat to left or right); the side is remembered per person with its width and hidden state, and stays on the right by default. The API accepts file attachments on a new conversation created from the console's Site view (the Site's id and version without a frame marker); Site code still can't attach anything.
