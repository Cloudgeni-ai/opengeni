// `@opengeni/desktop/dictation`: dictation from anywhere for any Electron app.
//
//   const dictation = createDesktopDictation({ productName, dataDir, reveal });
//   handleDictationIpc({ ipcMain, dictation, allow });
//   app.whenReady().then(() => dictation.start());
//   app.on("will-quit", () => dictation.stop());
//
// The page exposes the bridge with `exposeDictation()` from
// `@opengeni/desktop/preload/dictation` and records with `DesktopDictationHost`
// from `@opengeni/react/desktop-dictation`.

export * from "./index";
export { DictationHud, hudAction } from "./hud";
export { handleDictationIpc, parseDictationReport } from "./ipc";
export { createDesktopDictation, electronClipboard } from "./electron";
export type { CreateDesktopDictationOptions } from "./electron";
