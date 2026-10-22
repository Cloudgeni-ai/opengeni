---
"@opengeni/db": patch
"@opengeni/react": minor
"@opengeni/react-native": minor
---

A session's sub-agents now come back newest first at each level, and the 200-agent cap keeps direct agents and newer ones before deeper or older ones (it used to keep an arbitrary subset ordered by id). `sessionAgentAttention` and `formatWaitingSince` in `@opengeni/react/session-agents-model` give the word a manager must act on (Needs you · 10h, Failed, Stuck, Paused) for web and native. The phone's agents sheet shows that word in place of the time, and folds each agent's own agents behind a count.
