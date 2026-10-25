---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
---

A blocked "ask before each use" secret use now reaches the person through Opengeni itself instead of depending on the agent to relay a card. The resolver posts Opengeni's own approval card as a human-input request with the new `origin: "secret_use_approval"`, so it appears in the chat, the inbox, a phone notification (without an inline answer) and the Slack thread; an identical blocked use while the request is pending reuses it and never notifies again. The card outlives the turn that hit it. When the signed-in person answers, the grant or denial is recorded and the agent receives the new immediate `secret_use_approval_decided` update telling it to retry the call, or not to, which wakes an idle chat. `SessionHumanInputRequest` gains optional `origin`, `SessionSystemUpdateKind` gains `secret_use_approval_decided`, and `SecretReferenceError` carries `approval: { approvalId, asked }` instead of `approvalCard`; the `approval_required` tool output no longer includes a card and its hint says the person was asked. `request_human_input` refuses `secret-approval:` questions, and agent-relayed approval questions no longer carry authority. Migration 0961 (rolling) adds the request `origin` column and the new update kind, and keeps pending approval cards open in the inbox when a turn ends.
