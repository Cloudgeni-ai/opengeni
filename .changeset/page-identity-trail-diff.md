---
"@opengeni/react": patch
"@opengeni/sdk": patch
"@opengeni/db": patch
---

Pages now say where they are. In the macOS app the window bar shows a clickable trail before the page's title, such as "Agents › Meeting preparation" or "Organization settings › People"; on a detail page the back link moves into that trail and the page keeps its own title. An agent's Memory opened from the agent reads "Agents › Meeting preparation › Memory" and goes back to the agent, and a Knowledge entry's back link says "Knowledge". The web app keeps its layout.

History diffs are easier to read: a change is a tinted row with a coloured rule on its left edge instead of a boxed table, blank lines are dropped outside code, and the first version shows its text instead of every line marked as added.

Knowledge history now says "You" for the versions you saved, instead of "A teammate". Migration 1494 adds knowledge_entry_read's read-only `history_authors` operation, which returns only the ids of the asking person's own versions; `listKnowledgeEntryHistory` returns them as `savedByYou` and returns an empty list before the migration.
