---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Local installs have an Inbox. A local install's one human (the fixed `dev` subject of the built-in local organization) now gets its agents' questions, approvals, paused goals and notifications in the Inbox and can answer them there, as a signed-in person can. Only that human qualifies: the local bootstrap must have produced the request's access, as a keyless, non-delegated human session. API keys, services, agents, delegated bearers that name `dev`, and `dev` in any other organization still have no inbox. Phone pushes stay for signed-in people, because a push device is registered only by a native-app sign-in that local installs do not have.
