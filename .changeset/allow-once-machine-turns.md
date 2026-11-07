---
"@opengeni/db": patch
"@opengeni/react": patch
---

"Allow once" for a personal Connected Machine now works. Accepting the message used the one-time grant and filed its receipt against the message, but the check before the turn ran on the machine only accepted a receipt filed against the attempt, so every such turn failed with "A database error occurred." Migration 1340 lets that check accept the message's receipt for the same grant, turn, account and authority generation, so the message runs on the machine (including a retried attempt of the same turn), and the next message needs approval again. A turn whose machine approval is missing, used up, revoked or expired now ends with "Machine access needed: this chat isn’t allowed to use “<machine>” right now." (failure code `machine_access_required`) instead of a database error, and the machine's owner gets an "Allow for this chat" action in the failed-turn banner that approves the machine for the chat and continues. Failed-turn analytics add the `machine_access` class and the `allow_machine` action.
