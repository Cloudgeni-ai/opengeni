---
"@opengeni/runtime": patch
---

When a browser or computer tool is called with a session id that names no session, and the id is only a few characters off one of the chat's open sessions, the error now says so ("The browserSessionId you sent, …, is not …: they differ in 2 characters.") before listing the open sessions, since a slip in a long id is easy to read past. A session the API did not find is no longer listed among the open ones even when the chat's listing still shows it.
