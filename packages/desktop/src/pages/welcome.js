// @ts-check
// The first-run page: sign in through the browser, or add another account.
(() => {
  /** @type {import("../contract").DesktopWelcomeBridge} */
  // @ts-ignore -- defined by the welcome preload.
  const bridge = window.opengeniDesktopWelcome;
  const byId = (/** @type {string} */ id) =>
    /** @type {HTMLElement} */ (document.getElementById(id));
  const start = byId("start");
  const waiting = byId("waiting");
  const title = byId("title");
  const error = byId("error");
  const server = /** @type {HTMLInputElement} */ (byId("server"));
  const details = /** @type {HTMLDetailsElement} */ (byId("server-details"));
  const cancel = byId("cancel");
  let defaultServer = "";

  /** @param {import("../contract").WelcomeState} state */
  function render(state) {
    defaultServer = state.defaultServerUrl;
    title.textContent = state.canCancel ? "Add an account" : `Sign in to ${state.productName}`;
    document.title = title.textContent;
    server.placeholder = state.defaultServerUrl.replace(/^https?:\/\//u, "");
    start.hidden = Boolean(state.pendingServer);
    waiting.hidden = !state.pendingServer;
    byId("pending-server").textContent = state.pendingServer ?? "";
    error.hidden = !state.error;
    error.textContent = state.error ?? "";
    cancel.hidden = !state.canCancel;
  }

  function serverAddress() {
    return details.open && server.value.trim() ? server.value.trim() : defaultServer;
  }

  byId("form").addEventListener("submit", (event) => {
    event.preventDefault();
    void bridge.signIn(serverAddress());
  });
  byId("again").addEventListener("click", () => void bridge.signIn(serverAddress()));
  byId("restart").addEventListener("click", () => {
    start.hidden = false;
    waiting.hidden = true;
  });
  cancel.addEventListener("click", () => void bridge.cancel());
  details.addEventListener("toggle", () => {
    if (details.open) server.focus();
  });
  bridge.onChange(render);
  void bridge.state().then(render);
})();
