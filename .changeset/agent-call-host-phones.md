---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
---

Products embedding Opengeni can let agents call their users: the backend, acting as the person, states how many of their phones it rings (`setAgentCallHostPhones`, `PUT /v1/workspaces/:ws/agent-call-phones`), and agents count those phones alongside the Opengeni app's. The product rings its own app from the `session.agentCall.ringing` webhook.
