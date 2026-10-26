---
"@opengeni/sdk": patch
"@opengeni/desktop": patch
---

Any Electron app that shows Opengeni's meetings can now record the computer's audio, which includes the other people in a call, as its own track, the way the Opengeni desktop app does. `@opengeni/desktop/system-audio` exports `handleSystemAudioIpc` and `systemAudioHelperName` next to `SystemAudioCaptures`, and its `channels` option is now optional. `@opengeni/desktop/preload/system-audio` exports `exposeSystemAudio()`, which defines `window.opengeniSystemAudio`. The meeting recorder uses that global when the Opengeni desktop bridge is absent (`getDesktopSystemAudio` in `@opengeni/sdk/desktop-bridge`). Each desktop release attaches the helper binaries (`opengeni-audio-capture-<os>-<arch>`), and `SHA256SUMS` covers them. Inside an Electron app that can't record computer audio, the recorder no longer offers a browser tab's audio, because Electron has no share picker of its own and choosing it only failed.
