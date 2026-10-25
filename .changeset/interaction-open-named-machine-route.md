---
"@opengeni/runtime": patch
---

`computer_open` and `browser_open` with a placement naming a Connected Machine reuse an earlier session there only while the chat is working on that machine. Before, they reused a session left on a machine the chat had moved away from, and the agent got "This Desktop belonged to a previous task placement and was retired. Open a new Desktop.", which a new open could not fix. Now the open goes straight to the message that says to move the chat to that machine first.
