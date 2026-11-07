---
"@opengeni/runtime": patch
---

The automatic title request frames its user turn as the titling task, with the person's messages quoted inside it, so the title model names the conversation instead of answering the person's request. A message that is only a link, file or code without words of the person's own counts as nothing to name yet (`NO_TITLE`), so the chat is titled on a later turn in the person's own language instead of a guessed one.
