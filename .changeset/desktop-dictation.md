---
"@opengeni/desktop": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Dictation from anywhere in the desktop app: press a shortcut in any app, speak, press it again (or hold it while speaking), and the text is typed where the cursor is. Each shortcut can have its own language; on macOS a shortcut can be modifier keys alone (Control and Fn by default).

- `@opengeni/desktop/dictation`: the main-process controller (`createDesktopDictation`, `Dictation`), which watches the shortcuts, shows a small progress window at the bottom of the screen, and types the text by pasting it and putting the clipboard back (macOS with Accessibility, Windows through PowerShell, Linux through xdotool, wtype or ydotool), or only copies it. It keeps the last 50 texts on the computer. `handleDictationIpc` answers the page; `@opengeni/desktop/preload/dictation` exports `exposeDictation()`, which defines `window.opengeniDictation` for apps that aren't the Opengeni desktop shell.
- `@opengeni/react/desktop-dictation`: `DesktopDictationHost` records and transcribes for the shortcut on a signed-in page with the workspace's voice input, so each dictation is an ordinary dictation recording (a failed one offers Retry, a dismissed one stays saved for the composer). `DesktopDictationSettings` is the stock settings UI and `useDesktopDictation` the hook under it; `desktopShortcutLabel` and `acceleratorFromKey` name and record shortcuts.
- `useVoiceInput` takes `recover: false` for a host that dictates somewhere else, and returns `release()`, which lets go of the current dictation without deleting it.
- `@opengeni/sdk/desktop-bridge`: the `dictation` capability, the `DesktopDictation*` types, `getDesktopDictation()` and `DESKTOP_DICTATION_GLOBAL`.
