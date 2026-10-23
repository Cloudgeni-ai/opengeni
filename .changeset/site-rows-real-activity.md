---
"@opengeni/react": patch
"@opengeni/db": patch
---

Site rows in the sidebar sort only by real activity: their conversations, a new published version, and your own opens. Archiving, restoring or rolling back a Site no longer lifts it for everyone. The console records one open per visit to a Site, not again when its client is replaced, and not for a reload or restored tab that shows the Site again; a page that loads hidden counts once it is shown.
