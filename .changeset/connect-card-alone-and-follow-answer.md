---
"@opengeni/react": patch
---

Connect cards no longer ask "Who can use this connection?" when nobody else could use it: for services that are always personal (Gmail, Google Drive, Google Calendar) and for a person who is the only member of their workspace (including the one person on a local install), the card connects their own account straight away. After a person finishes a card, the conversation follows the agent's continuation instead of leaving it below the fold behind "Jump to latest"; focus stays on the card. Events from a card's setup dialog no longer count as reading the conversation, so scrolling or pressing keys there no longer stops following or loads older history.
