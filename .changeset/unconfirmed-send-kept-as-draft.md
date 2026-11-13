---
"@opengeni/react": patch
"@opengeni/db": patch
---

A durable Send that gets no definitive answer (the connection drops, or Opengeni is updating) now keeps its message as the draft, so it survives closing the page and shows on the person's other devices, as it did when every Send saved the draft first. Before, a message typed and sent within the autosave pause was in no draft, and closing the tab before the send went through lost it. The draft is written only while it is still at the revision the Send went ahead from, so it never brings back a message the server already accepted and never writes over another device's newer draft. When the Send lands later, the server clears a draft holding exactly what it sent.

An accepted Send now always moves the draft past the revision it went ahead from, also when nothing was ever saved: it creates an empty draft at revision 1 instead of leaving none.
