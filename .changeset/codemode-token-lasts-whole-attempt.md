---
---

A managed sandbox's Codemode client keeps working for the whole turn. On boxes the worker sets up before the run (the usual path), the Codemode token was never renewed, and every later model stream of the same attempt (for example after a context compaction) wrote the token from attempt start back into the box. The token lives one hour, so a turn running longer than an hour after its attempt started saw every Codemode call, and every new process, fail with 401 "authentication required" until the next turn. The setup for each stream now writes the attempt's newest token (minting a fresh one when it is close to expiry) and restarts renewal for exactly that token. Tokens stay bound to their attempt and keep their one-hour lifetime.
