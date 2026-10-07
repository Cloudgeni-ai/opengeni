---
"@opengeni/runtime": patch
---

The Codemode directive no longer says every available tool is callable programmatically. It now names the Codemode catalog (`ogtool list`) and says the built-in sandbox tools for the shell, file patching, image viewing and terminal input are outside it, so the agent uses the shell and filesystem directly for those.
