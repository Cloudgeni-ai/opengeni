---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Console test chats are isolated from each other: they are created with `agentAccess: "session"` and Memory off, so one tester's agent can't read or message another tester's test chats; a test chat's own login headers run only for turns its tester's principal started; and `x-opengeni-service-initiator` refuses the server-reserved `console-test:` prefix (422).
