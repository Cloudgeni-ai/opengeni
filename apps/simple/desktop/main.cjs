// Opengeni Simple for macOS: signs in to an Opengeni server with the native
// app flow, then runs the app's own server locally with that person's token
// and shows it in a window. The token is kept with Electron safeStorage (the
// macOS keychain) and handed to the server on stdin only.
//
// "This computer" (letting the person's agents use this Mac) lives in
// computer.ts and the window's bridge in preload.ts; desktop/bundle.ts bundles
// both into desktop/out, which build.sh and dev.sh run first.
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  nativeTheme,
  net,
  powerMonitor,
  safeStorage,
  shell,
} = require("electron");
const { spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { hostname } = require("node:os");
const { dirname, join } = require("node:path");

const { createSimpleComputer, openedAtLogin } = require("./out/computer.cjs");

const APP_ID = "ai.opengeni.simple";
const PRODUCT_NAME = "Opengeni Simple";
const SERVERS = [
  { label: "Staging", url: "https://staging.app.opengeni.ai" },
  { label: "Production", url: "https://app.opengeni.ai" },
];
// The only callback scheme the server accepts.
const REDIRECT_URI = "opengeni://auth/callback";

app.setName(PRODUCT_NAME);

const userData = app.getPath("userData");
const configPath = join(userData, "config.json");
let serverUrl = null;
let server = null;
let mainWindow = null;
let quitting = false;
/** The signed-in server's token while its app is open; null once signed out. */
let activeToken = null;
/** This Mac for the person's agents, from computer.ts; set once the app is ready. */
let computer = null;
/** Quitting was confirmed (or needs no question); the agent is stopping. */
let quitConfirmed = false;
let confirmingQuit = false;

function normalizeServerUrl(raw) {
  try {
    const url = new URL(/^[a-z]+:\/\//iu.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function saveServerUrl(url) {
  mkdirSync(userData, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ ...readConfig(), serverUrl: url }, null, 2));
}

/** One sign-in per server, so switching back and forth keeps both. */
function tokenPathFor(url) {
  return join(userData, "tokens", `${new URL(url).host}.bin`);
}

function readToken(url) {
  const tokenPath = tokenPathFor(url);
  if (!existsSync(tokenPath) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(readFileSync(tokenPath));
  } catch {
    return null;
  }
}

function writeToken(url, token) {
  const tokenPath = tokenPathFor(url);
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, safeStorage.encryptString(token), { mode: 0o600 });
}

// The server refuses unauthenticated writes from a client that doesn't name its
// API contract revision; the refusal names the current one, so adopt it and retry.
let apiContract = null;
async function api(base, path, init = {}, token) {
  const send = () =>
    net.fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(apiContract ? { "x-opengeni-api-contract": apiContract } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  const response = await send();
  if (response.status !== 409) return response;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  if (body?.code !== "API_CONTRACT_CHANGED" || !body.apiContractRevision) return response;
  if (body.apiContractRevision === apiContract) return response;
  apiContract = body.apiContractRevision;
  return send();
}

async function tokenStillValid(base, token) {
  try {
    const response = await api(base, "/v1/access/me", {}, token);
    return response.status !== 401 && response.status !== 403;
  } catch {
    return true; // offline or a server error: keep the token and let the app report it
  }
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

// The callback arrives through macOS as an opengeni:// link.
app.on("open-url", (event, url) => {
  if (!url.startsWith("opengeni:")) return;
  event.preventDefault();
  void finishSignIn(url);
});

// Opengeni.app usually owns opengeni://, so take it only while a sign-in is
// open; releasing it gives it back to the other registered handler.
async function claimCallbackScheme() {
  if (!app.isPackaged) return;
  // Right after install macOS may not know this app yet; give it a moment.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const claimed = app.setAsDefaultProtocolClient("opengeni");
    note(`claim opengeni (attempt ${attempt}): ${claimed}`);
    if (claimed) return;
    await new Promise((done) => setTimeout(done, 500));
  }
}
function releaseCallbackScheme() {
  if (app.isPackaged) note(`release opengeni: ${app.removeAsDefaultProtocolClient("opengeni")}`);
}

function note(line) {
  try {
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, "app.log"), `${new Date().toISOString()} ${line}\n`, {
      flag: "a",
    });
  } catch {}
}

// The sign-in window: pick a server, continue in the browser, wait for the callback.
let welcome = null;
let pending = null;

function render(state) {
  if (!welcome) return;
  welcome.state = { ...welcome.state, ...state };
  if (welcome.loaded)
    void welcome.window.webContents.executeJavaScript(`render(${JSON.stringify(welcome.state)})`);
}

function showWelcome({ canGoBack = false, error = null } = {}) {
  if (welcome) {
    render({ view: "start", server: serverUrl ?? SERVERS[0].url, canGoBack, error });
    welcome.window.show();
    return;
  }
  const dark = nativeTheme.shouldUseDarkColors;
  const window = new BrowserWindow({
    width: 440,
    height: 500,
    resizable: false,
    fullscreenable: false,
    show: false,
    title: "Sign in",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: dark ? "#121113" : "#fbfaf8",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  welcome = {
    window,
    loaded: false,
    closing: false,
    state: { view: "start", server: serverUrl ?? SERVERS[0].url, canGoBack, error },
  };
  const current = welcome;
  window.once("ready-to-show", () => window.show());
  window.webContents.on("did-finish-load", () => {
    current.loaded = true;
    render({});
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    event.preventDefault();
    const match = /^https:\/\/simple\.invalid\/([a-z]+)\?u=(.*)$/u.exec(target);
    if (match) void onWelcomeAction(match[1], decodeURIComponent(match[2]));
  });
  window.on("closed", () => {
    if (welcome === current) welcome = null;
    if (current.closing) return;
    cancelSignIn();
    if (!mainWindow) app.quit();
  });
  void window.loadFile(join(__dirname, "welcome.html"));
}

function closeWelcome() {
  if (!welcome) return;
  welcome.closing = true;
  welcome.window.destroy();
  welcome = null;
}

async function onWelcomeAction(action, value) {
  if (action === "back") return closeWelcome();
  if (action === "restart") {
    cancelSignIn();
    return render({ view: "start", error: null });
  }
  if (action === "again") {
    if (pending) void shell.openExternal(pending.url);
    return;
  }
  if (action !== "continue") return;
  const url = normalizeServerUrl(value);
  if (!url) return render({ error: "Enter an https address, like staging.app.opengeni.ai." });
  const token = readToken(url);
  if (token && (await tokenStillValid(url, token))) return openWorkspace(url, token);
  await beginSignIn(url);
}

async function beginSignIn(base) {
  cancelSignIn();
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));
  const url = new URL("/native-sign-in", base);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("state", state);
  url.searchParams.set("platform", "macos");
  url.searchParams.set(
    "device_name",
    `Opengeni Simple on ${hostname().replace(/\.local$/u, "")}`.slice(0, 80),
  );
  pending = { base, verifier, state, url: url.toString() };
  render({ view: "waiting", server: base, error: null });
  await claimCallbackScheme();
  if (pending?.state === state) void shell.openExternal(pending.url);
}

function cancelSignIn() {
  if (!pending) return;
  pending = null;
  releaseCallbackScheme();
}

async function finishSignIn(raw) {
  const request = pending;
  if (!request) return;
  cancelSignIn();
  app.focus({ steal: true });
  welcome?.window.show();
  try {
    const callback = new URL(raw);
    if (callback.searchParams.get("state") !== request.state)
      throw new Error("That sign-in didn't match this request. Try again.");
    const error = callback.searchParams.get("error");
    if (error)
      throw new Error(
        error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed (${error}).`,
      );
    const response = await api(request.base, "/v1/native-app/token", {
      method: "POST",
      body: JSON.stringify({
        code: callback.searchParams.get("code"),
        codeVerifier: request.verifier,
        redirectUri: REDIRECT_URI,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.accessToken)
      throw new Error(`Sign-in failed (${body.error || response.status}).`);
    writeToken(request.base, body.accessToken);
    await openWorkspace(request.base, body.accessToken);
  } catch (error) {
    render({
      view: "start",
      server: request.base,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function resource(...parts) {
  return app.isPackaged
    ? join(process.resourcesPath, ...parts)
    : join(__dirname, "build", ...parts);
}

async function startServer(token) {
  const port = await freePort();
  const dataDir = join(userData, "data", new URL(serverUrl).host);
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(resource("simple-server"), ["--serve-dist"], {
    env: {
      ...process.env,
      OPENGENI_SIMPLE_API_URL: serverUrl,
      OPENGENI_SIMPLE_FULL_APP_URL: serverUrl,
      OPENGENI_SIMPLE_API_KEY_STDIN: "1",
      OPENGENI_SIMPLE_DATA_DIR: dataDir,
      OPENGENI_SIMPLE_DIST_DIR: resource("dist"),
      OPENGENI_SIMPLE_HOST: "127.0.0.1",
      OPENGENI_SIMPLE_WEB_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(token);
  const logPath = join(userData, "server.log");
  const log = (chunk) => {
    try {
      writeFileSync(logPath, chunk, { flag: "a" });
    } catch {}
  };
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("exit", (code) => {
    if (server?.child === child) server = null;
    if (!quitting && code !== 0 && code !== null) {
      dialog.showErrorBox(
        "Opengeni Simple stopped",
        `The local server exited (code ${code}). See ${logPath}.`,
      );
    }
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await net.fetch(`${origin}/`);
      if (response.ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  server = { child, origin };
  return origin;
}

function stopServer() {
  server?.child.kill();
  server = null;
}

function openExternalSafely(url) {
  if (/^https?:/u.test(url)) void shell.openExternal(url);
}

function isBlank(url) {
  return url === "" || url === "about:blank";
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Connect flows (e.g. "Continue to Gmail") reserve a blank window during the
 * click, cut it off from the page (`opener = null`), point it at the provider
 * once the server answers, and then poll the server until the connection is
 * done; the window itself is never the completion signal. Provider sign-in
 * belongs in the person's own browser, where they are already signed in and
 * where providers such as Google allow it (they refuse embedded app windows).
 * So the blank window is accepted as a hidden placeholder and its first real
 * destination decides: this app's own pages show in an app window, anything
 * else opens in the browser and the placeholder closes. Every other link
 * (downloads, docs) opens in the browser directly.
 */
function routeWindowOpen(contents, origin) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isBlank(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          show: false,
          width: 520,
          height: 720,
          title: PRODUCT_NAME,
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#121113" : "#ffffff",
        },
      };
    }
    openExternalSafely(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (popup) => {
    const route = (event, url) => {
      if (isBlank(url)) return;
      if (sameOrigin(url, origin)) {
        if (!popup.isVisible()) popup.show();
        return;
      }
      // Sign-in happens in the user's browser. The hidden placeholder stays
      // open so the page keeps waiting for the backend to confirm the
      // connection; the page closes it once the attempt settles.
      event.preventDefault();
      openExternalSafely(url);
    };
    popup.webContents.on("will-navigate", route);
    popup.webContents.on("will-redirect", route);
    popup.webContents.setWindowOpenHandler(({ url }) => {
      openExternalSafely(url);
      return { action: "deny" };
    });
    // A placeholder the page never used goes with the page.
    const closeUnused = () => {
      if (!popup.isDestroyed() && !popup.isVisible()) popup.destroy();
    };
    contents.once("destroyed", closeUnused);
    popup.once("closed", () => contents.removeListener("destroyed", closeUnused));
  });
}

function showApp(origin, { hidden = false } = {}) {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 820,
      minWidth: 720,
      minHeight: 520,
      show: !hidden,
      title: PRODUCT_NAME,
      backgroundColor: "#ffffff",
      titleBarStyle: "default",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        preload: join(__dirname, "out", "preload.cjs"),
        // The preload exposes the bridge only on this origin.
        additionalArguments: [
          `--opengeni-simple-origin=${origin}`,
          `--opengeni-simple-product=${PRODUCT_NAME}`,
        ],
      },
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    routeWindowOpen(mainWindow.webContents, origin);
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!sameOrigin(url, origin)) {
        event.preventDefault();
        openExternalSafely(url);
      }
    });
  }
  void mainWindow.loadURL(origin);
  if (!hidden) mainWindow.show();
}

/**
 * Signed in: run the local server against this Opengeni and show the app.
 * `hidden` when opened at login: the app runs, without a window, so this
 * computer stays available to agents.
 */
async function openWorkspace(url, token, { hidden = false } = {}) {
  render({ view: "starting", server: url, error: null });
  serverUrl = url;
  activeToken = token;
  saveServerUrl(url);
  buildMenu();
  stopServer();
  mainWindow?.destroy();
  mainWindow = null;
  showApp(await startServer(token), { hidden });
  closeWelcome();
  computer?.reset();
}

async function launch() {
  serverUrl = normalizeServerUrl(
    process.env.OPENGENI_SIMPLE_SERVER_URL || readConfig().serverUrl || "",
  );
  buildMenu();
  const token = serverUrl ? readToken(serverUrl) : null;
  if (token && (await tokenStillValid(serverUrl, token)))
    return openWorkspace(serverUrl, token, { hidden: openedAtLogin() });
  showWelcome();
}

/** Clicking the Dock icon always brings a window forward, whatever state the app is in. */
function reveal() {
  if (mainWindow) return mainWindow.show();
  if (welcome) return welcome.window.show();
  if (server) return showApp(server.origin);
  showWelcome();
}

async function signOut() {
  const token = serverUrl ? readToken(serverUrl) : null;
  if (token)
    await api(serverUrl, "/v1/native-app/sign-out", { method: "POST", body: "{}" }, token).catch(
      () => {},
    );
  if (serverUrl) rmSync(tokenPathFor(serverUrl), { force: true });
  // Agents keep this computer (its agent has its own credentials); the app
  // just stops managing it as this person until they sign in again.
  activeToken = null;
  computer?.reset();
  showWelcome();
  stopServer();
  mainWindow?.destroy();
  mainWindow = null;
}

function switchServer() {
  showWelcome({ canGoBack: Boolean(mainWindow) });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: serverUrl ? `Server: ${new URL(serverUrl).host}` : "No server", enabled: false },
          { label: "Change Server…", click: () => switchServer() },
          { label: "Sign Out", enabled: Boolean(serverUrl), click: () => void signOut() },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => reveal());
  app.whenReady().then(() => {
    computer = createSimpleComputer({
      appId: APP_ID,
      productName: PRODUCT_NAME,
      account: () => (serverUrl && activeToken ? { serverUrl, token: activeToken } : null),
      appWindow: () =>
        mainWindow && server ? { contents: mainWindow.webContents, origin: server.origin } : null,
      reveal: () => reveal(),
      log: note,
    });
    // The agent has its own credentials, so it starts whether or not this
    // person's sign-in is still good.
    void computer.boot().catch((caught) => note(`this computer: ${String(caught)}`));
    void launch();
    // Nobody is there to answer when the system logs out, restarts or stops
    // the app: quit without asking, so the app never holds that up.
    const quitUnasked = () => {
      quitConfirmed = true;
      app.quit();
    };
    powerMonitor.on("shutdown", quitUnasked);
    process.once("SIGTERM", quitUnasked);
    process.once("SIGINT", quitUnasked);
  });
  app.on("activate", () => reveal());
  app.on("window-all-closed", () => {
    // Stay running in the dock like a normal Mac app: the server keeps avatars
    // painting, and agents keep this computer while it is connected.
  });
  app.on("before-quit", (event) => {
    if (!quitConfirmed) {
      event.preventDefault();
      void confirmQuit();
      return;
    }
    quitting = true;
    cancelSignIn();
    stopServer();
  });
  // However the app ends, its agent doesn't outlive it.
  app.on("will-quit", () => computer?.shutdownNow());
}

/**
 * Quitting stops the agent, so agents lose this computer until the app opens
 * again. While it serves them, ask first; closing the window keeps it available.
 */
async function confirmQuit() {
  if (confirmingQuit) return;
  confirmingQuit = true;
  try {
    if (computer && (await computer.quitNeedsQuestion())) {
      const options = {
        type: "question",
        buttons: ["Quit", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: `Quit ${PRODUCT_NAME}?`,
        detail:
          "Agents can't use this computer until you open the app again. To keep it available, close the window instead.",
      };
      const { response } = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (response !== 0) return;
    }
    quitConfirmed = true;
    await computer?.shutdown().catch(() => undefined);
    app.quit();
  } finally {
    confirmingQuit = false;
  }
}
