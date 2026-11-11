---
"@opengeni/contracts": patch
"@opengeni/db": patch
---

A waiting turn now restates its reset to everyone who was told, not only the person. When a later check finds the reset later than the one announced (its time passed without capacity, or a longer limit binds) or unknown, the session's timeline gets a new waiting event naming the reset that now holds, and a worker's parent gets a further `child_waiting_capacity` notice whose dedupe key adds that reset (child lifecycle notice protocol revision 4). An unchanged or earlier reset says nothing new.
