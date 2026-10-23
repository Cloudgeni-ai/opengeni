---
"@opengeni/browserd": patch
"@opengeni/sdk": patch
---

On macOS a computer-use batch step that names a button or link by name, when the control has the other of those two roles, now presses or checks the one element of that name once the window's complete reading has settled, and says which element it used, instead of waiting out its timeout and failing. Toggles never stand in, several such elements fail as ambiguous, and a window that never settles fails as before. A computer action receipt lists such actions in its optional `roleStandIns`.
