---
"@opengeni/contracts": patch
"@opengeni/api-router": patch
"@opengeni/react": patch
---

Embedded meetings are transcribed in the workspace's meeting language. `GET …/recording-models` now returns the workspace's `language` (null detects), and the meetings list's recorder starts on it when the host passes no `defaultLanguage`. Until it is known, starting a meeting names no language, so the server uses the workspace's. Before, an embedding that passed no language asked every meeting to detect it, which overrode the workspace setting and could return Norwegian as Danish or Swedish.
