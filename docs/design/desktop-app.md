# Opengeni desktop app

Status: design, 2026-10-14. Mac first, then Linux, then Windows.

## Goal

A desktop app for macOS, Windows and Linux that covers what people do 99% of
the time — sessions, chat, the inbox, attachments, voice, deep links — and makes
the computer it runs on available to agents with one click. The app must start
fast, feel native and stay small in code.

The shell is a reusable kit. Any product built on Opengeni can ship its own
desktop app by pointing the kit at its own web app and branding.

## Decisions

| Area | Decision |
|---|---|
| Shell | Electron (current stable, 44.x) on all three platforms. One engine, one shell. |
| Content | The deployment's own web app, loaded from the server the account belongs to, in a desktop layout. |
| Native code | Electron APIs first; `objc-js` for small macOS gaps; a typed native module for anything larger. |
| Look | Inset traffic lights and standard sidebar vibrancy on macOS; overlay window controls on Windows and Linux. No Liquid Glass. |
| Accounts | Several accounts on several servers, each in its own isolated browser session. |
| Local machine | "Use this computer" installs (if needed) and connects the connected-machine agent in one click, using the deployment's own signed installer. The agent keeps its own updater and service. |
| Background | The agent keeps running after the window closes, with a menu bar / tray item and a pause control. |
| Packaging | electron-builder: DMG (Developer ID, notarized), NSIS (Authenticode), AppImage plus deb and rpm. |
| Updates | electron-updater for the shell; the web content updates with the server; the agent keeps its own signed updater. |
| Out of scope now | Global quick-ask hotkey, offline use, Mac App Store, Liquid Glass. |

## Architecture

```
┌──────────────────────── Opengeni.app ────────────────────────┐
│ main process (thin, TypeScript)                              │
│  accounts · windows · menus · tray · notifications ·         │
│  deep links · updater · agent supervisor · inbox listener    │
│        ▲ typed IPC (preload bridge, versioned)               │
│ ┌──────┴──────────────────────────────┐   ┌───────────────┐  │
│ │ web content per account             │   │ opengeni-agent│  │
│ │ https://<server>/  (desktop layout) │   │ (Rust, signed)│  │
│ │ sandboxed, context-isolated         │   │ user service  │  │
│ └─────────────────────────────────────┘   └───────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Shell and content

The main process owns everything that needs the operating system and nothing
else. The window shows the web app served by the account's server, so the
content is always the version that matches the server, every UI fix reaches
desktop when the server deploys, and several accounts on servers of different
versions just work.

The web app detects the desktop bridge and switches to a desktop layout:

- every page of the web app, settings included, stays in the window: it is
  already signed in, and keeping one surface costs no extra code. Settings…
  (⌘,) opens the workspace settings in the window;
- the top of the sidebar leaves room for the traffic lights and is a window
  drag region; the sidebar background is transparent so vibrancy shows through;
- accounts, sign-out and "Use this computer" go through the bridge; links to
  other origins open in the default browser.

Logic lives in the shared TypeScript code of the web app. The main process only
performs operating-system calls: show this notification, open this URL, start
the agent with this token.

### Bridge

One preload script exposes a small, typed `window.opengeniDesktop` object. It
is versioned and capability-based: the web content asks what the shell supports
and degrades gracefully, because the shell and the server update independently.
The bridge is exposed only to the account's own server origin. All other
navigation opens in the default browser. Renderers run sandboxed with context
isolation and no Node integration.

### Fast start

- The main process is a small pre-bundled ES module with no work before the
  first window beyond reading the account list. The SDK and the updater load
  lazily in split chunks after the window is up.
- The window opens with the theme background already painted (no white flash)
  and is shown on first paint.
- Each account's persistent session keeps the HTTP cache and Chromium's code
  cache warm across launches, so hashed web assets and parsed JavaScript are
  reused. A last-good offline copy of the app shell is a later step if cold
  loads over slow networks miss the budget.
- Start-up marks are written to `$OPENGENI_DESKTOP_PERF` for measurement.
- Electron fuses lock the binary down: no `ELECTRON_RUN_AS_NODE`, no
  `NODE_OPTIONS`, ASAR integrity, load only from ASAR, encrypted cookies.

Budgets, measured on every build on an Apple silicon Mac and tuned on real
hardware:

| Measure | Target |
|---|---|
| Window visible, cold start | ≤ 300 ms |
| Usable with cached sessions, cold start | ≤ 800 ms |
| Warm start | ≤ 200 ms |
| Memory with one account open, idle | ≤ 250 MB |
| Idle CPU | ≈ 0% |

## Accounts and sign-in

Sign-in uses the deployment's existing native sign-in (`/native-sign-in`,
RFC 8252 with PKCE), the same flow as the mobile app: the system browser opens,
the person signs in with any web method and allows the device, and the app
redeems the one-time code for its own revocable credential. Signing in inside
the app window is avoided because identity providers block embedded browsers.

- The redirect is the `opengeni://auth/callback` scheme registered by the app.
- Credentials are stored with Electron `safeStorage` (Keychain, DPAPI,
  libsecret).
- Each account has its own persistent browser session partition, so cookies and
  storage never mix.
- The window's web session comes from the app credential: the shell calls
  `POST /v1/native-app/web-session` with it inside the account's partition,
  and the server sets its normal session cookie. When that cookie expires, the
  web app asks the bridge to restore it; if the credential itself is revoked,
  the window offers "Sign in again".
- An account switcher sits at the top of the sidebar, like mobile.

## Notifications

While the app runs, the main process reads each account's inbox with
`@opengeni/sdk` and the account's credential every 30 seconds and on wake or
unlock, including when no window is open. The first reading only records what
is already there; new or changed items become native notifications with actions
where the platform allows it (approve, deny, choose, reply), mirroring the
mobile and web inbox. Clicking opens the session at the item's moment. The dock
badge counts the items that need the person.

## Deep links

The app registers `opengeni://` and handles links to sessions and workspaces of
signed-in accounts in the app, picking the right account by server and
workspace, exactly like mobile. Back and forward work inside the window.

## This computer

The app does not carry its own copy of the agent. It uses the agent the
deployment already ships, so there is one signed agent, one updater and one
service per machine, whether it was set up from the app or from the one-line
installer.

1. After sign-in the app offers "Use this computer".
2. The app asks the server for a single-use personal enroll token
   (`scope: "user"`). If the agent is installed, the app runs
   `opengeni-agent connect --non-interactive` with the token in the
   environment, never on the command line, then starts the service. If not, it
   downloads the server's `install.sh` or `install.ps1` and runs it with the
   same token. Nothing to copy or paste.
3. The agent runs as a per-user service (launchd, systemd, a Windows service)
   and keeps running after the window closes.
4. Screen control is a switch in the same dialog; the operating system's
   Screen Recording and Accessibility prompts name the agent app.
5. A second account gets the same one-click offer but is never connected
   automatically.

The menu bar / tray item shows whether the computer is connected and offers
Open, Pause this computer, Resume and Quit. Pause stops the service without
unlinking the computer. An existing agent install is adopted as it is: its
connections are kept and shown.

Headless machines keep the one-line installer and need no desktop app.

## Packaging, signing and updates

| Platform | Package | Signing | Update |
|---|---|---|---|
| macOS (universal) | DMG and ZIP | Developer ID, hardened runtime, notarized | electron-updater from ZIP |
| Windows (x64, arm64) | NSIS installer | Authenticode through the existing Azure signing | electron-updater, differential |
| Linux (x64, arm64) | AppImage, deb, rpm | Signed checksums | AppImage self-update; deb and rpm through the package manager |

Releases are published to GitHub Releases next to the agent releases, with
stable and beta channels. The signing identity is a release-time setting.

## Repository layout

- `packages/desktop`: the reusable kit — main-process modules (accounts,
  windows, tray, notifications, deep links, updater, agent supervisor), the
  preload bridges, the first-run page and the typed contract. Products
  configure it with their name, icons, scheme, default server and colors.
- `apps/desktop`: the Opengeni desktop app — configuration, icons, build
  script and electron-builder config.
- `apps/web`: the desktop layout and the bridge client.
- `packages/sdk` (`@opengeni/sdk/app-links`): server and app-link parsing
  shared by the mobile and desktop apps.

## Phases

1. macOS: kit, app, sign-in with several accounts, desktop layout, deep links,
   notifications, "Use this computer", tray, updater, signed
   and notarized DMG, budgets measured. About 4–6 agent-hours.
2. Linux: AppImage, deb and rpm, Wayland and X11 checks. A few hours.
3. Windows: NSIS, Authenticode, overlay title bar, CUA computer use. A few hours.

## Risks

- Remote content in a privileged shell: mitigated by an origin-bound, minimal
  bridge, sandboxed renderers and fuses.
- Shell and server versions drift: the bridge negotiates capabilities.
- Electron's size and memory floor: accepted; budgets keep it honest.
