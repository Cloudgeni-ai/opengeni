---
"@opengeni/react": minor
---

Show who sent a message in shared chats. User message items now carry the sender recorded with the message, and `MessageTimeline` (and `SessionConversation` timeline props) accept `renderMessageSender` to draw a small label above the bubble. Nothing is drawn unless the host supplies it, so embedders that have no identity for their users, or do not want attribution, see no change. `MessageSenderLabel` renders an avatar or initials with a name. The web app names other members' messages and leaves your own unlabeled.
