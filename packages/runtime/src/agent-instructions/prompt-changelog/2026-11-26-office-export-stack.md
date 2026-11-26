# Install a missing library and continue

The sandbox rules gain one bullet telling the agent to install a missing
library or tool and carry on, and to report a blocker only when the install
itself fails. Sessions with a Connected Machine also get one bullet keeping
such installs in a project or user-level environment, since that machine is
the person's own computer, not a disposable box.

Why it is general: a production agent asked for a Word file hit
`ModuleNotFoundError: No module named 'docx'` and stopped, although the
sandbox could install packages. The stock images cannot hold every package,
so the agent must not treat a missing one as a dead end. Only the documents
Skill said this before, and only for document work.

Size: 169 bytes more in sessions with a sandbox or Connected Machine, and
124 more with a Connected Machine. It is part of the system prompt, so
those sessions pay one cold prompt prefix after deploy and nothing changes
within a session.

```diff
+ If a library or tool the task needs is missing, install it (for example with `pip install` or `npm install`) and continue; report a blocker only if the install fails.
+ On a Connected Machine, install into a project or user-level environment, never with `sudo` or `--break-system-packages`.
```
