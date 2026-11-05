---
"@opengeni/db": patch
---

Releasing the turns that wait on a Modal box whose save failed no longer deadlocks with ordinary session writers. The release locked each waiting turn first, then its session: clearing the wait fires the turn's archive guard, which locks the session. Every other writer locks the session first, then its turns, so a writer such as turn recovery that held a session and then asked for its turn deadlocked with the release, and PostgreSQL aborted one of them. The release now finds the waiters without locking, locks their sessions and then their turns in id order through the shared event-write lock helper, checks again that each turn is still waiting, and wakes the sessions in id order.
