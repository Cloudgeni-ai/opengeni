import {
  authorizeConnectAttempt,
  type ConnectBrowserWindow,
  type ConnectController,
} from "@opengeni/connect";

/** Reserve the isolated window during Continue's user gesture, before the
 * account selection round trip. Only the server's returned stage supplies its URL. */
export async function selectGitHubConnectAccount(
  controller: ConnectController,
  accountId: string,
  browser: ConnectBrowserWindow,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const popup = browser.open("about:blank", "_blank", "popup,width=520,height=720");
  if (!popup) throw new Error("GitHub popup was blocked. Allow popups and try again.");
  const close = () => {
    try {
      popup.close();
    } catch {
      /* Closing never replaces the setup result. */
    }
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    popup.opener = null;
    if (popup.opener !== null) throw new Error("GitHub popup isolation failed");
    const attempt = await controller.advance({ type: "account", accountId }, crypto.randomUUID());
    signal.throwIfAborted();
    if (attempt.nextAction.type !== "authorize") return;
    const result = await authorizeConnectAttempt(
      controller.transport,
      attempt,
      {
        openPopup(url) {
          popup.location.replace(url);
          return { close };
        },
        redirect() {
          throw new Error("GitHub selection requires its reserved popup");
        },
      },
      { mode: "popup", signal },
    );
    signal.throwIfAborted();
    if (result) await controller.recover(result.id);
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}
