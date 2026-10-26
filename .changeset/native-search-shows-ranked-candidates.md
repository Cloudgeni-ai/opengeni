---
"@opengeni/runtime": patch
---

On OpenAI/Azure Responses and Codex routes, a tool search with no single clear match no longer reads as "No matching tools found" when ranking found likely tools: the model now sees the same compact candidates the generic route lists, in a short note after the result, and can load the right ones by exact name. Loading a connected account's tools by exact name now names the person's other matching accounts (for example Outlook Mail next to Gmail), once per turn. With several accounts of one connector, ranking ignores each tool's account line, and compact previews show the account and then what the tool does.
