---
"@opengeni/browserd": patch
---

On macOS, keys based on a reading the app did not answer are refused even after a later reading has answered, since the reading they name showed no focused element. `set_value` now tells a web `<select>`'s open menu by the item the menu marks as chosen rather than by its highlighted item, which the pointer or arrow keys can move over a neighbouring select, and when it opened a menu and then refuses, it closes that menu even if it could not tell it for the select's. Finding the read window no longer asks for more window numbers once its deadline has passed.

A sheet takes background keys for its window only when the app's focused element is in it, so a file panel whose contents another process serves stays refused whatever it calls itself. Each reading of an app's focus before background keys has one second in all, so an app that stopped answering cannot hold it for a messaging timeout per request. A window that once proved to be an unreadable sheet stops counting as one when it closes, goes off screen, no longer lies within another window of its app, or reads.
