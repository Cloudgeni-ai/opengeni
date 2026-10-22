// Opengeni Simple for macOS: signs in to an Opengeni server with the native
// app flow, then runs the app's own server locally with that person's token
// and shows it in a window. The token is kept with Electron safeStorage (the
// macOS keychain) and handed to the server on stdin only.
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  nativeTheme,
  net,
  safeStorage,
  shell,
} = require("electron");
const { spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { hostname } = require("node:os");
const { dirname, join } = require("node:path");

const SERVERS = [
  { label: "Staging", url: "https://staging.app.opengeni.ai" },
  { label: "Production", url: "https://app.opengeni.ai" },
];
// The only callback scheme the server accepts.
const REDIRECT_URI = "opengeni://auth/callback";

app.setName("Opengeni Simple");

const userData = app.getPath("userData");
const configPath = join(userData, "config.json");
let serverUrl = null;
let server = null;
let mainWindow = null;
let quitting = false;

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

async function api(base, path, init = {}, token) {
  return net.fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
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

function showApp(origin) {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 820,
      minWidth: 720,
      minHeight: 520,
      title: "Opengeni Simple",
      backgroundColor: "#ffffff",
      titleBarStyle: "default",
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/u.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(origin)) {
        event.preventDefault();
        if (/^https?:/u.test(url)) void shell.openExternal(url);
      }
    });
  }
  void mainWindow.loadURL(origin);
  mainWindow.show();
}

/** Signed in: run the local server against this Opengeni and show the app. */
async function openWorkspace(url, token) {
  render({ view: "starting", server: url, error: null });
  serverUrl = url;
  saveServerUrl(url);
  buildMenu();
  stopServer();
  mainWindow?.destroy();
  mainWindow = null;
  showApp(await startServer(token));
  closeWelcome();
}

async function launch() {
  serverUrl = normalizeServerUrl(
    process.env.OPENGENI_SIMPLE_SERVER_URL || readConfig().serverUrl || "",
  );
  buildMenu();
  const token = serverUrl ? readToken(serverUrl) : null;
  if (token && (await tokenStillValid(serverUrl, token))) return openWorkspace(serverUrl, token);
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
    void launch();
  });
  app.on("activate", () => reveal());
  app.on("window-all-closed", () => {
    // Stay running in the dock like a normal Mac app; the server keeps avatars painting.
  });
  app.on("before-quit", () => {
    quitting = true;
    cancelSignIn();
    stopServer();
  });
}
