---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Find in a chat (Cmd/Ctrl+F) now covers the whole chat and starts at the newest match. It counts every match ("3 / 120" instead of "1 / 50+"), Previous from the first match goes to the newest and Next from the newest goes back to the first, and Enter, Shift+Enter, the arrows and Cmd/Ctrl+G all step through matches. Session message search accepts `order: "newest"` to walk messages newest first; the default stays `oldest`, and `groupBy: "session"` only supports `oldest`.
