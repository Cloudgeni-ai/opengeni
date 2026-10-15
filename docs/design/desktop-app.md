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
| Look | Inset traffic lights and standard sidebar vibrancy on macOS; the page's own title row under the system caption buttons on Windows; the system title bar on Linux. No Liquid Glass. |
| Accounts | Several accounts on several servers, each in its own isolated browser session. |
| Local machine | "Use this computer" installs (if needed) and connects the connected-machine agent in one click, using the deployment's own signed installer. The agent keeps its own updater and service. |
| Background | The agent keeps running after the window closes, with a menu bar / tray item and a pause control. |
| Packaging | electron-builder: DMG (Developer ID, notarized), NSIS (Authenticode once a signing identity exists), AppImage plus deb and rpm. |
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
| Memory with one account open, idle (private footprint, below) | ≤ 250 MB |
| Idle CPU | ≈ 0% |

Memory is the private footprint of all of the app's processes, the figure each
system's monitor reports: physical footprint on macOS (Activity Monitor),
private bytes on Windows, and private dirty pages plus swap on Linux. Summed
resident sizes are not used, because every process maps the same shared
framework pages and they would be counted once per process.

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
3. The agent runs as a per-user service (a launchd LaunchAgent, a systemd user
   unit, a Windows logon task in the user's desktop session) and keeps running
   after the window closes. If an installed agent cannot start, Connect replaces
   it with the server's current release through the same installer.
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
| Windows (x64, arm64) | NSIS installer, per user | GitHub build provenance attestations; Authenticode once a signing identity is configured | electron-updater, differential |
| Linux (x64, arm64) | AppImage, deb, rpm | SHA-256 checksums and GitHub build provenance attestations | AppImage self-update; deb and rpm download in the app and install with the user's password |

Each version is published as its own GitHub release, `desktop-v<version>`,
next to the agent releases. Releases in the repository are immutable once
published, so the workflow fills a draft and then publishes it, and installed
apps look up the newest stable `desktop-v` tag and read that release's update
files. Products configure their own feed (a fixed URL or a repository and tag
prefix). The signing identity is a release-time setting.

### Distribution

People get the app four ways, all from the same releases:

- **From the web app.** The account menu's "Desktop app" row offers the
  download for the browser's platform, the install command, and the release
  page with every platform. It is hidden inside the desktop app and on phones.
- **From any Opengeni server.** `GET /desktop/latest/<file>` redirects a
  version-less file name (`Opengeni-mac.dmg`, `Opengeni-windows.exe`,
  `Opengeni-linux-amd64.deb`, `SHA256SUMS`, ...) to that file on the current
  release, and `GET /desktop/latest` to the release page. The current release
  is the newest stable `desktop-v` tag, looked up on GitHub and cached for ten
  minutes, unless the operator pins `OPENGENI_DESKTOP_STABLE_VERSION`. GitHub's
  own "latest release" can't be used: agent and package releases share the
  repository.
- **With one command.** `curl -fsSL https://<server>/desktop/install.sh | sh`
  installs or updates the app on macOS (into `/Applications`, after checking
  the checksum, signature and notarization) and Linux (deb through apt, rpm
  through dnf, yum or zypper, else the AppImage). The served script resolves
  the release through its server, so a pin applies; a copy run from the
  repository asks GitHub.
- **With Homebrew.** `brew install --cask cloudgeni-ai/tap/opengeni`. The
  release workflow writes the cask (`apps/desktop/homebrew/opengeni.rb`) to the
  tap for every stable release. The cask declares `auto_updates`, since the
  app updates itself.

winget follows once the Windows installer is Authenticode-signed.

### Linux notes

- The window class (Wayland app id and X11 `WM_CLASS`) is the executable
  name, and the packaged desktop entry declares the same `StartupWMClass`, so
  the dock and overview match the running window to its entry and icon.
- Icons ship in the standard hicolor sizes up to 512 px; larger sizes are
  not looked up by desktops.
- An AppImage registers itself on first launch: it writes a user desktop
  entry (with the URL scheme handler) and icon, and rewrites them when the
  file moves. deb and rpm installs register through the package.
- The system title bar is kept. On Wayland, GNOME may maximize a large
  window while mapping it without a resize event, so layout follows the
  content view's own bounds. A restored maximized window is maximized once
  it is shown, since a maximize issued while hidden is dropped on X11.
- Ubuntu 24.04 restricts unprivileged user namespaces: the deb installs an
  AppArmor profile, and the AppImage falls back to running without the
  Chromium sandbox when namespaces are unavailable.

### Windows notes

- The page runs under the window's caption buttons (the window controls
  overlay), as in other current Windows apps, so there is one title row. The
  buttons are as tall as the session title bar and their glyphs follow the
  app's appearance. The page reads the free part of that row from the
  `titlebar-area-*` environment variables, so whatever reaches the top-right
  corner (the session title bar or a docked workspace panel) makes room for
  the buttons, and pages without a title bar of their own start below the
  row, which moves the window, with content fading out beneath it.
- One installer carries both architectures for people to download; installed
  apps update from the installer for their own architecture. It installs per
  user, without administrator rights.
- The app sets its application user model ID to the packaged app id, which is
  what Windows attributes notifications and the Start menu shortcut to.
- Until an Authenticode identity is configured, SmartScreen warns on first
  run; build provenance attestations still let people check a download.

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
3. Windows: NSIS, caption buttons over the page's title row, CUA computer use, Authenticode once an identity exists. A few hours.

## Risks

- Remote content in a privileged shell: mitigated by an origin-bound, minimal
  bridge, sandboxed renderers and fuses.
- Shell and server versions drift: the bridge negotiates capabilities.
- Electron's size and memory floor: accepted; budgets keep it honest.
