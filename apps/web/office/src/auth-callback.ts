// The sign-in dialog lands here with `?code=…&state=…`; hand that back to the
// task pane that opened the dialog.
void Office.onReady().then(() => {
  Office.context.ui.messageParent(window.location.search.slice(1));
});
