/**
 * Dictation from anywhere in a desktop app: the person presses a shortcut in
 * any app, speaks, and the text is typed where their cursor is.
 *
 * The app's main process owns the shortcuts, the small window that shows a
 * dictation's progress and where the text goes (`@opengeni/desktop/dictation`).
 * Mount {@link DesktopDictationHost} once on the signed-in pages: it records
 * and transcribes with the account's workspace, the way the composer does.
 * Show {@link DesktopDictationSettings} where the app's settings are, or build
 * your own on {@link useDesktopDictation}.
 */
export { DesktopDictationHost, dictationErrorMessage } from "./components/desktop-dictation/host";
export type {
  DesktopDictationClient,
  DesktopDictationHostProps,
} from "./components/desktop-dictation/host";
export {
  DesktopDictationSettings,
  profileName,
  useDesktopDictation,
} from "./components/desktop-dictation/settings";
export type {
  DesktopDictationSettingsProps,
  UseDesktopDictationResult,
} from "./components/desktop-dictation/settings";
export {
  acceleratorFromKey,
  desktopShortcutLabel,
  modifierName,
  sameDesktopShortcut,
} from "./components/desktop-dictation/shortcuts";
