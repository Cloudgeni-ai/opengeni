# @opengeni/desktop

## 5.0.2

### Patch Changes

- Updated dependencies [ca3f931]
- Updated dependencies [487bd43]
- Updated dependencies [a9d20b3]
- Updated dependencies [171cdb7]
- Updated dependencies [3083c1e]
- Updated dependencies [6d29c01]
- Updated dependencies [f975174]
- Updated dependencies [4afe92f]
- Updated dependencies [217ed52]
  - @opengeni/sdk@5.0.0
  - @opengeni/agent-host@5.0.0

## 4.8.0

### Patch Changes

- Updated dependencies [3089aaf]
- Updated dependencies [e2a641c]
  - @opengeni/sdk@4.8.0
  - @opengeni/agent-host@4.8.0

## 4.7.2

### Patch Changes

- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
  - @opengeni/sdk@4.7.2
  - @opengeni/agent-host@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/agent-host@4.7.1
- @opengeni/sdk@4.7.1

## 4.7.0

### Patch Changes

- @opengeni/sdk@4.7.0
- @opengeni/agent-host@4.7.0

## 4.6.1

### Patch Changes

- Updated dependencies [e7ca55f]
  - @opengeni/sdk@4.6.0
  - @opengeni/agent-host@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [f838cb7]
- Updated dependencies [debd64e]
- Updated dependencies [3e4426e]
- Updated dependencies [68c3907]
- Updated dependencies [e38f20d]
- Updated dependencies [e22eeca]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
  - @opengeni/sdk@4.5.0
  - @opengeni/agent-host@4.5.0

## 4.4.1

### Minor Changes

- da48573: `@opengeni/desktop` is published to npm, so a product can build its own branded desktop app on the kit without copying it from this repository. The package ships compiled JavaScript and types for its entry points (`@opengeni/desktop`, `/contract`, `/mac-login-agent`, `/preload` and `/preload/welcome`), and the welcome pages sit next to the contract entry as before. It joins the other packages' shared version line.
- b58a428: The desktop kit now fits a product whose web app has its own routes and its own server.

  - `webPaths` in the desktop kit's config says where the product's web app shows a workspace, a session, the inbox and settings. The app reads links, reopens the last page and opens notifications and menu commands with it. `parseAppLink`, `parseComputerConnectLink` and `computerConnectUrl` take the same `AppWebPaths`; `OPENGENI_WEB_PATHS` is Opengeni's own web app and stays the default.
  - The "Open in app" handoff uses the app's own scheme: `parseAppLink(url, { scheme })`, `appHandoffUrl(url, scheme)` and `openInAppUrl(url, scheme)`.
  - `allowOtherServers: false` hides "Use another server" on the first-run page, and the app then signs in to its own server only. Its messages name the configured server instead of Opengeni's.
  - `agentPath`, `agentConfigDir` and `adoptStandaloneAgent` pass through to `ThisComputer`, so an app can keep its own agent apart from a separately installed one.

- a1a907c: A product can let its own branded build of the Opengeni Browser Chrome extension reach the person's agent. Set `browserExtensionIds` (Chrome's 32-letter extension IDs) in the desktop kit's config, or in `ThisComputer`'s options; the agent then lists those extensions next to Opengeni Browser in the Chrome Native Messaging host it registers. Standalone installs read the same list from `OPENGENI_AGENT_BROWSER_EXTENSION_IDS` when running `opengeni-agent service install`. This needs an agent built from this release or later.

### Patch Changes

- 335e275: Handle Open app and connect inside the desktop window through the existing account authorization and local consent flow instead of silently dropping the app link.
- 524ddde: The desktop app shows an Update button at the bottom of the sidebar as soon as it finds a new version. One click installs it: a downloaded update restarts the app at once, otherwise the download finishes and the app restarts by itself. The app now checks for updates every hour, and the desktop bridge gains an `updates` capability (state, install and change events).
- 0e3434e: The package entry is now `src/index.ts` (built to `dist/index.js`), like every other published Opengeni package, so the kit passes the publish checks. Imports from `@opengeni/desktop` are unchanged.
- 6e37e50: The desktop app reopens any page the product's `webPaths.match` recognizes, including pages whose address names no workspace (`match` returns `{ workspaceId: null, sessionId: null }`); the account keeps its last known workspace. Links to such pages still open in the browser.
- Updated dependencies [524ddde]
- Updated dependencies [b58a428]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [d295544]
- Updated dependencies [614c744]
- Updated dependencies [a1a907c]
- Updated dependencies [81a516c]
- Updated dependencies [60e031c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [84c8b32]
- Updated dependencies [84b1a18]
  - @opengeni/sdk@4.4.0
  - @opengeni/agent-host@4.4.0

## 0.3.0

### Minor Changes

- 0e135b2: Add a command menu and keyboard shortcuts. ⌘K (Ctrl+K on Windows and Linux) opens one list of chats and actions: recent chats, actions for the open chat (copy link, pin, rename, mark unread, archive) and general actions, with "Search messages" handing the query to full-history search. ⌘/ opens a cheat sheet of every shortcut. One action registry feeds the menu, the chat row and header menus, tooltips and the desktop menu bar, so a key or label is defined once. `@opengeni/react/ui/context-menu` exports `ContextMenuShortcut`, and the prebuilt `@opengeni/react/compiled.css` includes the new menu's styles.

  The SDK's desktop bridge adds the `menuActions` capability with `DesktopMenuAction` and `DesktopMenuSection`, so the desktop app builds its menu bar from the actions the page reports; older desktop builds keep their static menu. Chat title search matches every word of the query in any order, in the title or first message, instead of one literal substring.

- 2963eca: App-shots in the desktop app. When turned on in Settings → Machines, a shortcut (both Command keys on macOS by default) attaches the window you are looking at in another app to the chat you are using: a screenshot plus the window's app, title and the text it shows, including text scrolled out of view. Nothing is sent until you send it, and the attachment can be removed first. The agent receives the window's text as untrusted data inside that message only, so earlier turns stay unchanged. When your computer is connected to the workspace, the agent also learns which machine and window it was, so it can keep working in that window with computer tools; for a browser window it also gets the page address and the browser profile connected through the Opengeni extension, so it can continue in that tab with browser tools. Uploads accept an optional `appShot` description for image files (`uploadFile` in the SDK), and `useFileAttachments` gains `addAppShot`. macOS only for now; Windows and Linux plug into the same capture boundary.

### Patch Changes

- 687d3f9: App-shots work on macOS releases where `osascript` never calls a JavaScript `run` handler (macOS 26.2 among them). There the shortcut could not be set up, the permission check reported nothing, and captures failed. Each helper now calls its own entry point with its arguments.
- bc9a7f9: Connecting an account from the desktop app works again. Connect, GitHub and model sign-in buttons that open a sign-in window failed with "Allow popups to connect your account", because the app refused every new window. The app now accepts the blank window such a flow reserves, opens the provider's sign-in page in your browser, and the app picks up the finished connection by itself. Pages from the account's own server that a flow opens show as an app window.
- 427f2a5: Leave existing standalone agents untouched when the desktop app opens. Explicit
  signed-in setup reuses their service and signed installation, preserving macOS
  privacy grants. Service-backed pause/resume persists across logins; quitting the
  desktop does not stop the service. Permission guidance uses the running agent's
  reported grants rather than probing the desktop app. Existing agents require
  the matching native release with structured service inspection before management.
- Updated dependencies [49f2177]
- Updated dependencies [bb438b0]
- Updated dependencies [0e135b2]
- Updated dependencies [03947ed]
- Updated dependencies [bf39d5e]
- Updated dependencies [fda625e]
- Updated dependencies [2963eca]
- Updated dependencies [579239a]
- Updated dependencies [ffe09c2]
- Updated dependencies [1b57d74]
- Updated dependencies [277c99c]
- Updated dependencies [b20c9b2]
- Updated dependencies [70f0522]
- Updated dependencies [c236847]
- Updated dependencies [23fed2a]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [427f2a5]
- Updated dependencies [724b529]
- Updated dependencies [2058cd3]
- Updated dependencies [3915617]
- Updated dependencies [908c0d3]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [b95784c]
- Updated dependencies [83a467d]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/sdk@4.3.0
  - @opengeni/agent-host@4.3.0

## 0.2.3

### Patch Changes

- Updated dependencies [641e179]
- Updated dependencies [8c38fe4]
- Updated dependencies [5252d01]
- Updated dependencies [e018445]
- Updated dependencies [47eeb80]
  - @opengeni/sdk@4.2.0
  - @opengeni/agent-host@4.2.0

## 0.2.2

### Patch Changes

- Updated dependencies [404e017]
  - @opengeni/sdk@4.1.2
  - @opengeni/agent-host@4.1.2

## 0.2.1

### Patch Changes

- Updated dependencies [afff3f9]
- Updated dependencies [04019de]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/sdk@4.1.0
  - @opengeni/agent-host@4.1.0

## 0.2.0

### Minor Changes

- e2e75c0: "Use this computer" is now a reusable kit, so any product's desktop app can let its agents work on the person's own computer the way the Opengeni desktop app does.

  - `@opengeni/agent-host` runs the connected-machine agent from a desktop app: it downloads and signature-checks the agent (or uses one bundled in a store package with `bundledAgent`), connects it with a personal enroll token, pauses and resumes it, and on macOS walks the person through Screen Recording, Accessibility and Input Monitoring with a guide window beside System Settings that names the app and ticks off each switch as it is turned on.
  - `@opengeni/sdk/this-computer` holds the shared shapes (status, permissions, error codes, the host interface) and `allowAgentsOnComputer`, which grants the person's agents standing use of their computer, so no chat has to ask again.
  - `@opengeni/react/this-computer` has the screens: the setup dialog (intro, download progress, one permission at a time, done), the sidebar offer, the settings panel with pause, resume and turn off, and the conversation card that turns this computer on from a chat inside the desktop app and, elsewhere, says whether the person's computer is ready or where to get the app. Every word is in the message catalog under `thisComputer.*`, so a product translates them, and names its own agent, with the rest of its text; the look follows the og design tokens, with the kit's own stylesheet in `@opengeni/react/this-computer.css`. What macOS itself calls things (its permission lists and buttons) is quoted in the Mac's own language: English is built in, and a host adds others with a `MacSystemNameCatalog`.
  - The Opengeni web app now uses these screens in the desktop app: the rail offer, a "This computer" panel on the Machines page, and "Use this computer" as the connected-machine card's action when the chat runs inside the desktop app.
  - Conversation steps that find machines, move onto one and back, and use its screen now read plainly ("Looked at the screen", "Typed “hello”") from catalog keys, and a deferred tool run through `tool_invoke` is shown as the tool it ran.

### Patch Changes

- 24b346d: Using this computer in a second workspace no longer fails. A person's own computer already serves every workspace they belong to on the same server, so connecting it in another workspace now reuses the existing connection and only lets the person's agents there use it, instead of setting it up again (which the server refuses). Turning it off in one workspace takes back only that workspace's standing permission (new `disallowAgentsOnComputer`) and keeps it on elsewhere; it is disconnected when the last workspace stops using it.
- Updated dependencies [2f6b8bd]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [79ec9fd]
- Updated dependencies [6ab7b55]
- Updated dependencies [a22ed79]
- Updated dependencies [5b10fc9]
- Updated dependencies [e2e75c0]
- Updated dependencies [24b346d]
  - @opengeni/sdk@4.0.0
  - @opengeni/agent-host@4.0.0

## 0.1.7

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [60191f6]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/sdk@3.4.0

## 0.1.6

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/sdk@3.3.0

## 0.1.5

### Patch Changes

- Updated dependencies [a0c35a1]
  - @opengeni/sdk@3.2.0

## 0.1.4

### Patch Changes

- 482d1ca: When the desktop app takes over the separate Mac agent app, screen control carries over. The app now lists the Screen Recording and Accessibility permissions to allow again, and says so once in a notification. Before, agents silently lost the use of the screen.
- 90266f0: Connecting this computer from the desktop app now lets your agents use it in your chats in that workspace, private and shared, without asking again in every chat; only turns you start can use it. An app installed by a server's install script suggests that server at first sign-in. Linux gets overlay scrollbars, the keyring is opened only when a credential is first read or stored, and the server address field comes before Continue when you use another server.
- a7197d8: The desktop app keeps checking for updates after one has downloaded, so an app that stays open for days moves on to the newest release instead of staying on the first update it found.
- Updated dependencies [17d61c6]
- Updated dependencies [74a259d]
  - @opengeni/sdk@3.1.0

## 0.1.3

### Patch Changes

- Updated dependencies [9a15dda]
- Updated dependencies [664368a]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
  - @opengeni/sdk@3.0.0

## 0.1.2

### Patch Changes

- Updated dependencies [e8d18da]
  - @opengeni/sdk@2.0.1

## 0.1.1

### Patch Changes

- Updated dependencies [04ebc42]
- Updated dependencies [e03f1ff]
- Updated dependencies [055015d]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [4532435]
- Updated dependencies [851cbdc]
- Updated dependencies [496ce55]
- Updated dependencies [c08dfcd]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [8017d94]
- Updated dependencies [121f6ed]
- Updated dependencies [5b4a738]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [0c6f5c4]
- Updated dependencies [c13d080]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [945490f]
- Updated dependencies [4d8eb5e]
- Updated dependencies [8e878ac]
- Updated dependencies [9701372]
- Updated dependencies [da01634]
- Updated dependencies [ab3306a]
- Updated dependencies [eb68b58]
- Updated dependencies [38b1ba1]
- Updated dependencies [6960770]
- Updated dependencies [e125c0c]
- Updated dependencies [3426850]
- Updated dependencies [412671a]
- Updated dependencies [63bf721]
- Updated dependencies [3a4a435]
- Updated dependencies [14343e4]
- Updated dependencies [2b8ee21]
- Updated dependencies [945c247]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [5441ac9]
- Updated dependencies [945c247]
- Updated dependencies [cb9e426]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [8cf9e0a]
- Updated dependencies [7852cda]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [a51c96e]
- Updated dependencies [7f3f19f]
- Updated dependencies [35fb6fd]
- Updated dependencies [35fb6fd]
- Updated dependencies [7bf1a02]
- Updated dependencies [a13bf1a]
- Updated dependencies [945c247]
- Updated dependencies [c676ae8]
- Updated dependencies [a91718c]
  - @opengeni/sdk@2.0.0
