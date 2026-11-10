---
"@opengeni/desktop": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Dictation from anywhere now has one workspace of its own. Settings → Dictation gains a Workspace row (shown when the person can use more than one workspace), and every shortcut dictation goes to that workspace and is billed to it, whichever workspace the window shows. The recorder runs outside the workspace screens, so switching workspace mid-dictation no longer stops it. When the person has left that workspace, voice input is off there, or it doesn't offer a shortcut's model, the setting says so on the row at fault and the popup offers "Open settings"; a dictation never falls back to another workspace. The desktop bridge's dictation settings carry the chosen workspace (`DesktopDictationWorkspace`).
