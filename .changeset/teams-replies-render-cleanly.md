---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Opengeni's replies in Microsoft Teams render cleanly. A Markdown table becomes one list item per row, led by its first cell, with every other cell on its own nested line, instead of one line of cells joined by semicolons that ran together. Teams leaves no gap between paragraphs, so a heading or a bold heading line after a paragraph now gets a blank line before it and stays on its own line; the help and welcome text follow the same rules. Notices about a chat's session (Started, needs your input or approval, could not finish) and the refusal notices are now a card with an "Open in Opengeni" style button instead of a bare URL. In a channel thread the agent's answer after the Started card now gets its own message header with the AI label, instead of being grouped under the notice.
