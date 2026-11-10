---
"@opengeni/runtime": patch
---

Chats no longer get stuck after their history picks up provider-specific reasoning that the next request can't use.

- Claude models with prefix-bound thinking, such as Opus 5.5 and Sonnet 5.5, now always let Claude drop thinking blocks whose earlier prefix changed, instead of rejecting the whole request with "Invalid signature in thinking block". The system prompt can change between turns, for example when a repository Skill appears after a branch checkout. Signed blocks are still sent unchanged, and an unchanged prefix drops nothing.
- Raw reasoning text that a Responses-compatible provider returns in a reasoning item's `content` (for example an open-weight model behind a custom endpoint) now goes back natively only to that provider. Other providers, such as Azure OpenAI, receive it as readable historical text instead of rejecting the request. Items stored before this change carry no origin, so they are always sent as readable text, including to the provider that produced them.
