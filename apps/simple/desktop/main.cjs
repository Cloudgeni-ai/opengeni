// Opengeni Simple for macOS: signs in to an Opengeni server with the native
// app flow, then runs the app's own server locally with that person's token
// and shows it in a window. The token is kept with Electron safeStorage (the
// macOS keychain) and handed to the server on stdin only.
const { app, BrowserWindow, Menu, dialog, net, safeStorage, shell } = require("electron");
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

function readToken() {
  const tokenPath = tokenPathFor(serverUrl);
  if (!existsSync(tokenPath) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(readFileSync(tokenPath));
  } catch {
    return null;
  }
}

function writeToken(token) {
  const tokenPath = tokenPathFor(serverUrl);
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, safeStorage.encryptString(token), { mode: 0o600 });
}

async function api(path, init = {}, token) {
  const response = await net.fetch(`${serverUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  return response;
}

async function tokenStillValid(token) {
  try {
    const response = await api("/v1/access/me", {}, token);
    if (response.status === 401 || response.status === 403) return false;
    return true; // offline or a server error: keep the token and let the app report it
  } catch {
    return true;
  }
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

// The callback arrives through macOS as an opengeni:// link.
let pendingCallback = null;
app.on("open-url", (event, url) => {
  if (!url.startsWith("opengeni:")) return;
  event.preventDefault();
  pendingCallback?.(url);
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
    writeFileSync(join(userData, "app.log"), `${new Date().toISOString()} ${line}\n`, {
      flag: "a",
    });
  } catch {}
}

function signIn() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));
  const url = new URL("/native-sign-in", serverUrl);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("state", state);
  url.searchParams.set("platform", "macos");
  url.searchParams.set(
    "device_name",
    `Opengeni Simple on ${hostname().replace(/\.local$/u, "")}`.slice(0, 80),
  );

  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({
      width: 380,
      height: 200,
      resizable: false,
      title: "Opengeni Simple",
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    let settled = false;
    const done = () => {
      settled = true;
      pendingCallback = null;
      releaseCallbackScheme();
      if (!window.isDestroyed()) window.destroy();
    };
    pendingCallback = async (raw) => {
      if (settled) return;
      done();
      app.focus({ steal: true });
      try {
        const callback = new URL(raw);
        if (callback.searchParams.get("state") !== state)
          throw new Error("That sign-in didn't match this request.");
        const error = callback.searchParams.get("error");
        if (error)
          throw new Error(
            error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed (${error}).`,
          );
        const response = await api("/v1/native-app/token", {
          method: "POST",
          body: JSON.stringify({
            code: callback.searchParams.get("code"),
            codeVerifier: verifier,
            redirectUri: REDIRECT_URI,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.accessToken)
          throw new Error(`Sign-in failed (${body.error || response.status}).`);
        resolve(body.accessToken);
      } catch (error) {
        reject(error);
      }
    };
    window.webContents.on("will-navigate", (event, target) => {
      event.preventDefault();
      if (target.startsWith("https://simple.invalid/retry"))
        void shell.openExternal(url.toString());
    });
    window.on("closed", () => {
      if (settled) return;
      done();
      reject(new Error("Sign-in was cancelled."));
    });
    void window.loadURL(waitingPage());
    void claimCallbackScheme().then(() => shell.openExternal(url.toString()));
  });
}

function page(title, body) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-content:center;text-align:center;gap:12px;padding:0 24px;background:#fff;color:#242424}
@media(prefers-color-scheme:dark){body{background:#202020;color:#eee}input{color:#eee}}
button,input{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid #c4c4c4;background:transparent;color:inherit}
button.primary{background:#242424;color:#fff;border-color:#242424}@media(prefers-color-scheme:dark){button.primary{background:#eee;color:#242424}}
.row{display:flex;gap:8px;justify-content:center}input{width:260px}.muted{color:#7a7a7a;font-size:12px}</style>${body}`)}`;
}

function waitingPage() {
  return page(
    "Sign in",
    `<b>Finish signing in in your browser</b><span class="muted">${new URL(serverUrl).host}</span><div class="row"><button onclick="location.href='https://simple.invalid/retry'">Open again</button><button onclick="window.close()">Cancel</button></div>`,
  );
}

function serverPage(current) {
  const presets = SERVERS.map(
    ({ label, url }) =>
      `<button class="${url === current ? "primary" : ""}" onclick="location.href='https://simple.invalid/server?u='+encodeURIComponent('${url}')">${label}</button>`,
  ).join("");
  return page(
    "Choose a server",
    `<b>Which Opengeni do you want to use?</b><div class="row">${presets}</div>
<form class="row" onsubmit="event.preventDefault();location.href='https://simple.invalid/server?u='+encodeURIComponent(this.u.value)"><input name="u" placeholder="Or another address" value="${current && !SERVERS.some((entry) => entry.url === current) ? current : ""}"><button>Use</button></form>
<span class="muted">You can change this later from the app menu.</span>`,
  );
}

/** Asks which server to use; resolves with its origin, or null when the window is closed. */
function chooseServer(current) {
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      width: 460,
      height: 260,
      resizable: false,
      title: "Opengeni Simple",
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    let settled = false;
    window.webContents.on("will-navigate", (event, target) => {
      event.preventDefault();
      const match = /^https:\/\/simple\.invalid\/server\?u=(.*)$/u.exec(target);
      const url = match ? normalizeServerUrl(decodeURIComponent(match[1])) : null;
      if (!url) {
        void dialog.showMessageBox(window, {
          type: "warning",
          message: "Enter an https address, like staging.app.opengeni.ai.",
        });
        return;
      }
      settled = true;
      window.destroy();
      resolve(url);
    });
    window.on("closed", () => {
      if (!settled) resolve(null);
    });
    void window.loadURL(serverPage(current));
  });
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

async function launch() {
  serverUrl ??= normalizeServerUrl(
    process.env.OPENGENI_SIMPLE_SERVER_URL || readConfig().serverUrl || "",
  );
  if (!serverUrl) {
    serverUrl = await chooseServer(SERVERS[0].url);
    if (!serverUrl) return app.quit();
    saveServerUrl(serverUrl);
  }
  buildMenu();
  let token = readToken();
  if (token && !(await tokenStillValid(token))) token = null;
  while (!token) {
    try {
      token = await signIn();
      writeToken(token);
    } catch (error) {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: `Not signed in to ${new URL(serverUrl).host}`,
        detail: error instanceof Error ? error.message : String(error),
        buttons: ["Try again", "Choose another server", "Quit"],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 2) {
        app.quit();
        return;
      }
      if (response === 1) {
        const next = await chooseServer(serverUrl);
        if (next) {
          serverUrl = next;
          saveServerUrl(next);
          buildMenu();
          token = readToken();
          if (token && !(await tokenStillValid(token))) token = null;
        }
      }
    }
  }
  stopServer();
  showApp(await startServer(token));
}

async function signOut() {
  const token = readToken();
  if (token)
    await api("/v1/native-app/sign-out", { method: "POST", body: "{}" }, token).catch(() => {});
  rmSync(tokenPathFor(serverUrl), { force: true });
  stopServer();
  mainWindow?.destroy();
  mainWindow = null;
  await launch();
}

async function switchServer() {
  const next = await chooseServer(serverUrl);
  if (!next || next === serverUrl) return;
  serverUrl = next;
  saveServerUrl(next);
  stopServer();
  mainWindow?.destroy();
  mainWindow = null;
  await launch();
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
          { label: "Change Server…", click: () => void switchServer() },
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
  app.on("second-instance", () => mainWindow?.show());
  app.whenReady().then(() => {
    void launch();
  });
  app.on("activate", () => {
    if (mainWindow) mainWindow.show();
    else if (server) showApp(server.origin);
  });
  app.on("window-all-closed", () => {
    // Stay running in the dock like a normal Mac app; the server keeps avatars painting.
  });
  app.on("before-quit", () => {
    quitting = true;
    if (pendingCallback) releaseCallbackScheme();
    stopServer();
  });
}
