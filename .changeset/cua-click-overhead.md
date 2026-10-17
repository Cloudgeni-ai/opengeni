---
"@opengeni/browserd": patch
---

macOS computer-use actions are much faster. A background accessibility click on a new element took about 1.5 to 2 seconds, almost all of it driver overhead around a press that takes a few milliseconds; it now takes about 0.7 seconds. The agent cursor stays visible but moves in 150 ms without a pause after each click (CUA's default made every move take at least 600 ms, and each action waits for the cursor to arrive). The CUA worker also no longer glides a hidden cursor or spawns `ps` to detect Electron apps before every click, key press, scroll and value change.
