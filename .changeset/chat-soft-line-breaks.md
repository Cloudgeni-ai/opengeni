---
"@opengeni/react": patch
---

Chat messages now show a single newline as a line break, so an agent reply written on three lines (1, 2, 3) shows three lines instead of "1 2 3", the same as ChatGPT or GitHub comments. This applies to agent replies, progress notes, and your own messages in the Opengeni web app and in embeds that use the default `MessageTimeline` renderer. Code blocks, lists, tables, quotes, and headings render as before. Custom renderers can opt in with the new `softLineBreaks` prop on `Markdown`.
