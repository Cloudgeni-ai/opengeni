import { office } from "./host";

function open(
  url: string,
  size: { height: number; width: number },
  promptBeforeOpen: boolean,
): Promise<string> {
  const Office = office();
  return new Promise((resolve, reject) => {
    Office.context.ui.displayDialogAsync(url, { ...size, promptBeforeOpen }, (result) => {
      if (result.status !== "succeeded") {
        // 12009: the person ignored Office's "allow this window" prompt.
        // 12011: the browser's popup blocker stopped a window opened without one.
        reject(
          Object.assign(new Error(result.error?.message ?? "The window didn't open."), {
            blocked: result.error?.code === 12011,
          }),
        );
        return;
      }
      const dialog = result.value;
      dialog.addEventHandler(Office.EventType.DialogMessageReceived, (event) => {
        dialog.close();
        resolve(event.message ?? "");
      });
      dialog.addEventHandler(Office.EventType.DialogEventReceived, () => {
        reject(new Error("The window was closed before it finished."));
      });
    });
  });
}

/**
 * Opens `url` in an Office dialog (a real top-level window, where sign-in pages
 * and their cookies work, unlike the pane on Excel on the web) and resolves with
 * the first message its page sends with `Office.context.ui.messageParent`.
 * The page must be on one of the add-in's app domains.
 *
 * Call it straight from a click: then the window needs no extra "allow"
 * prompt. If a popup blocker stops it anyway, Office's prompt is used instead.
 */
export async function openOfficeDialog(
  url: string,
  size: { height: number; width: number } = { height: 70, width: 35 },
): Promise<string> {
  return await open(url, size, false).catch((error: { blocked?: boolean }) => {
    if (error?.blocked) return open(url, size, true);
    throw error;
  });
}
