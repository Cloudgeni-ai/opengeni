---
"@opengeni/react": patch
---

Keep every chat header on one row of the same height. The automations chip and the parent chat link now sit on the title's row instead of adding a row above it, so the header no longer grows when a chat has an automation or a parent. The automations chip lists each event and the next run on hover, collapses to its icon in narrow headers, and gives up its space before the title does.
