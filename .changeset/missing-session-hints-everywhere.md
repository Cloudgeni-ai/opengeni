---
"@opengeni/runtime": patch
"@opengeni/browserd": patch
---

Every browser and computer tool that names a BrowserSession or ComputerSession now answers a missing id with this chat's open sessions of that kind: browser_open and computer_open when attaching, the browser clipboard, downloads, download save, recording save, publish and lifecycle tools, computer lifecycle, and the native computer tools. Tools that need an id only list the ids to use; open tools also offer to open or reuse one. Session labels are shortened by character, so an emoji is never cut in half. A browser launch that fails no longer discards the record of the tabs its stopped predecessor had, so the retry still says which reopened tab shows each old tab's page.
