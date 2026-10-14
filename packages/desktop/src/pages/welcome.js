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
  const unreachable = byId("unreachable");
  const retry = /** @type {HTMLButtonElement} */ (byId("retry"));
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
    const out = state.unreachable;
    unreachable.hidden = !out;
    start.hidden = Boolean(out || state.pendingServer);
    waiting.hidden = Boolean(out || !state.pendingServer);
    byId("pending-server").textContent = state.pendingServer ?? "";
    if (out) {
      document.title = "Can't connect";
      byId("unreachable-server").textContent = out.server;
      for (const name of document.querySelectorAll(".product-name")) {
        name.textContent = state.productName;
      }
      // Not disabled, so the button keeps keyboard focus between tries.
      retry.setAttribute("aria-disabled", String(out.retrying));
      retry.textContent = out.retrying ? "Trying…" : "Try again";
    }
    error.hidden = !state.error;
    error.textContent = state.error ?? "";
    cancel.hidden = Boolean(out) || !state.canCancel;
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
  retry.addEventListener("click", () => void bridge.retry());
  details.addEventListener("toggle", () => {
    if (details.open) server.focus();
  });
  bridge.onChange(render);
  void bridge.state().then(render);
})();
