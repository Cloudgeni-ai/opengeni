# Install a missing library and continue

The sandbox rules gain one bullet telling the agent to install a missing
library or tool and carry on, and to report a blocker only when the install
itself fails.

Why it is general: a production agent asked for a Word file hit
`ModuleNotFoundError: No module named 'docx'` and stopped, although the
sandbox could install packages. The stock images cannot hold every package,
so the agent must not treat a missing one as a dead end. Only the documents
Skill said this before, and only for document work.

Size: 169 bytes more, in sessions with a sandbox or Connected Machine. It is
part of the system prompt, so those sessions pay one cold prompt prefix after
deploy and nothing changes within a session.

```diff
+ If a library or tool the task needs is missing, install it (for example with `pip install` or `npm install`) and continue; report a blocker only if the install fails.
```
