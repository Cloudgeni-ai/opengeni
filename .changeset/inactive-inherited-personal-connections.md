---
"@opengeni/db": patch
---

Keep agent work running when one of its inherited personal accounts lapses. Agent messages, child sessions and goal continuations inherit the exact personal accounts their person accepted. When one of those accounts later needed re-authorization or was revoked, the database refused the whole turn, so a single expired account blocked every child session and agent message that inherited it. The lapsed account now stays recorded on the turn without any authority, so every use of it is denied and it is never revived, matching how a lapsed shared workspace account already behaves. A mismatched owner, provider or kind is still refused.
