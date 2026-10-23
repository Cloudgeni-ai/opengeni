---
"@opengeni/react": patch
"@opengeni/db": patch
---

Site rows in the sidebar sort only by real activity: their conversations, a new published version, and your own opens. Archiving, restoring or rolling back a Site no longer lifts it for everyone. The console records one open per page that shows a Site: not again when its client is replaced, and not again when a reload, restored tab or Back shows a page where it was already recorded. A page that loads hidden counts once it is shown.
