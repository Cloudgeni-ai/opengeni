---
"@opengeni/runtime": patch
---

The lean `exec_command` schema's `tty` hint names `write_stdin` only when the same tool list offers `write_stdin`. Sessions whose backend runs commands without stdin (Connected Machines and several cloud providers) now read "Allocate a TTY. Omit for the default of false." instead of a hint pointing at a tool they don't have. Sessions that offer `write_stdin` keep a byte-identical tool block. The choice depends only on whether `write_stdin` is in the list, which is fixed for a placement, so a session's tool block still changes only when its placement does.
