export { DesktopShell, cookieFromHeader } from "./app";
export type { DesktopAppConfig, DesktopUpdateFeed } from "./config";
export { newestReleaseTag, resolveUpdateFeedUrl } from "./update-feed";
export {
  AccountStore,
  type AccountsState,
  type SecretCipher,
  type StoredAccount,
} from "./accounts";
export * from "../contract";

import type { DesktopAppConfig } from "./config";
import { DesktopShell } from "./app";

/** Start a desktop app. Call once, at the top of the main process entry. */
export function createDesktopApp(config: DesktopAppConfig): void {
  DesktopShell.launch(config);
}
