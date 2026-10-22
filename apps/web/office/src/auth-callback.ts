// The sign-in dialog lands here with `?code=…&state=…`; hand that back to the
// task pane that opened the dialog.
import { office } from "@opengeni/sdk/office";

void office()
  .onReady()
  .then(() => {
    office().context.ui.messageParent(window.location.search.slice(1));
  });
