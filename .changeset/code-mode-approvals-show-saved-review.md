---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

An action the agent asked for from Code Mode can be approved in embedded chats again. Such an approval carries no arguments of its own, since they stay in the action's saved review on the server, and `SessionConversation` (and so `OpenGeniChat`) never read that review: a fresh request showed "The details of this older request couldn't be recovered" with only Decline, also when a host's `approvalProps.loadReview` resolved `null` for it. The conversation now reads the saved review (`getToolActionReview`, with `getToolReviewDetails` for its details) for every approval the host's own loader leaves to the standard card. `NativeSessionScreen` does the same when it is given the full `client`. A session client without these two methods keeps the old behaviour.
