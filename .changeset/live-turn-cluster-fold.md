---
"@opengeni/react": minor
---

Completed activity clusters of a still-running turn now fold behind neutral chips (facets + a quiet pulse dot; no verdict glyph — the turn has none yet), keeping only the live tail expanded. This bounds the DOM of very long autonomous turns the same way settled folding bounds history; on settle, everything collapses into the single turn fold as before. TurnSummary's `outcome` prop is now optional (absent = in-progress cluster).
