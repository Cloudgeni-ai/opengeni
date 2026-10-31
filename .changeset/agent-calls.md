---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Agents can call a person. The new `call_user` tool rings the person's phones with the system's incoming-call screen (CallKit on iOS, through a PushKit VoIP push) when something cannot wait, waits up to 40 seconds while it rings, and returns `answered`, `declined`, `missed` or `cancelled`. Answering opens the chat's voice call, which starts by saying why the agent called. Nothing rings until the person turns on "Let agents call this iPhone" on that phone (native push rule `call`); "Teammates' agents too" (`call_members`) lets agents of other workspace members call them. One call rings a person at a time, a chat calls at most three times an hour, and after a decline it cannot call again for 15 minutes. A missed call leaves a "Missed call" notification. New: `session.agentCall.ringing` and `session.agentCall.settled` events (also subscribable by workspace webhooks, so a product can ring its own app with its own push credentials), `GET /v1/workspaces/:workspaceId/agent-calls/:callId` with `/answer` and `/decline`, the SDK's `getAgentCall`, `answerAgentCall` and `declineAgentCall`, the native push device's `voipToken`, and in `@opengeni/react-native` `useIncomingAgentCalls` and `useNativeVoipToken`.
