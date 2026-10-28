---
"@opengeni/db": patch
---

Answering a secret approval card now resumes the agent in the approver's own receiving context, the same way a finished capability setup does. Before, the resumed run had no initiating person, so a reference to a secret in the approver's personal vault could not resolve and the agent asked for the password again.
