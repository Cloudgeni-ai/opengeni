---
"@opengeni/db": patch
---

Releasing the turns that wait on a Modal box whose save failed now locks those turns in turn-id order, the order every other multi-turn writer uses. Before, it locked them in whatever order the query plan scanned them. Two releases for one box, or a release and another writer, could then deadlock, and PostgreSQL would abort one of them.
