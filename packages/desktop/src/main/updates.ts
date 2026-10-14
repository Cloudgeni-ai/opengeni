import { Notification } from "electron";

import type { DesktopUpdateFeed } from "./config";
import { resolveUpdateFeedUrl } from "./update-feed";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;

/**
 * App updates from the product's feed. Downloads happen in the background; the
 * update installs on the next quit, or right away from its notification. The
 * updater loads after startup, so it never slows launch.
 */
export function startUpdates(productName: string, feed: DesktopUpdateFeed): void {
  setTimeout(() => {
    void import("electron-updater")
      .then(({ autoUpdater }) => {
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        let announced = false;
        autoUpdater.on("update-downloaded", (info) => {
          if (announced || !Notification.isSupported()) return;
          announced = true;
          const notification = new Notification({
            title: `${productName} ${info.version} is ready`,
            body: "Restart to update. It also installs the next time you quit.",
          });
          notification.on("click", () => autoUpdater.quitAndInstall());
          notification.show();
        });
        autoUpdater.on("error", () => undefined);
        let lastUrl: string | null = null;
        const check = () =>
          void resolveUpdateFeedUrl(feed)
            .then((url) => {
              if (!url) return;
              if (url !== lastUrl) autoUpdater.setFeedURL({ provider: "generic", url });
              lastUrl = url;
              return autoUpdater.checkForUpdates();
            })
            .catch(() => undefined);
        check();
        setInterval(check, CHECK_EVERY_MS).unref();
      })
      .catch(() => undefined);
  }, FIRST_CHECK_DELAY_MS).unref();
}
