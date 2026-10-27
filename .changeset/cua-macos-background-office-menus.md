---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

On macOS, a window named by its id (`cua:window:<pid>:<window>`) is a computer-use target while its app lists it on any window level, so a dialog an app raises above its working windows can be observed as well as read, and a target missing from the last listing is looked up again before it is reported gone. An element invoke the driver cannot confirm, with nothing changed after it, now gets the same "may not have taken effect" line as an unconfirmed click, and that line points to the app's menu bar: some toolbar buttons that open a menu ignore an accessibility press while their app is in the background, while the same command in the menu bar works.

Pins CUA 6c821745: a press whose window closes within a second counts as done even when the app answered with an error, a `run_steps` press re-sent after its window closed reports the first press as done, and `get_desktop_state` reports how long ago the keyboard, mouse or trackpad was last used, ignoring input agents send to apps in the background.
