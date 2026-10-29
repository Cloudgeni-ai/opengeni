---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Follow-ups to "Let the agent decide":

- `HumanInputFormMessages.letAgentDecide` and `agentDeciding` are optional. A host's complete message set written before they existed type-checks again, and the card uses the default copy for any key the host leaves unset.
- The chat record of a hand-off stops reading the sub-session's question once it is settled.
- The record's words, and the text of the hand-off message, come from the host's messages (`humanInputDelegation.message`, `humanInputDelegation.messageWithMore`, `messageTimeline.agentDecided`, `messageTimeline.agentDecidedSummary`, `messageTimeline.answeredSummary`).
- A hand-off another member sent no longer reads "You let the agent decide". It reads "Let the agent decide" under that member's name.
- A hand-off that fails to send shows the API's own message on the card (for example "The service is updating. Try again in a moment."). It no longer shows the generic "The request could not be completed."
