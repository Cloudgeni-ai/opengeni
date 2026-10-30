---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Find in a chat (Cmd/Ctrl+F) now covers the whole chat and starts at the newest match. It counts matches in the background, so the bar reads "3 / 120" instead of "1 / 50+"; in a chat with thousands of matches it shows how many it has found so far. Previous from the first match goes to the newest, Next from the newest goes straight to the first, and Enter, Shift+Enter, the arrows and Cmd/Ctrl+G all step through matches. Closing and reopening the bar starts again at the newest match. Session message search accepts `order: "newest"` to walk messages newest first; the default stays `oldest`, and `groupBy: "session"` only supports `oldest`.
