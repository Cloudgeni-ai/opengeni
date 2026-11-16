---
"@opengeni/db": patch
---

Approving a tool call that changes connector permissions no longer stops the session. When an approved call, such as an update of the GitHub action approvals, changed connector permissions while its turn was running, the turn's next step refused to continue with "conflicts with a different or closed ownership chain". A running turn now keeps the permissions it started with when it picks up new messages or replays its claim, and the change applies from the next turn.
