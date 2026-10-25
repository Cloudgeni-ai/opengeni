# @opengeni/desktop

## 5.3.1

### Minor Changes

- 3b9f0e5: The desktop app notices calls. When Zoom, Teams, Slack, Webex, FaceTime, Discord or a meeting in a browser starts using the microphone, a notification offers to record it; when the recorded call ends, another offers to stop. The bundled audio helper reports which processes use a microphone (`--watch-microphone`) on macOS 14 and later, Windows and Linux with PipeWire or PulseAudio, without asking for any permission. Pages get the new `meetingDetection` capability: `status()`, `update({ enabled })`, `setRecording()`, `onRequest()` and `onChange()`. The switch is on by default and stored per computer.
- c992791: Record other apps' audio in desktop meeting recordings. The desktop app ships a small native helper that captures what the computer plays, apart from the app's own sounds: a Core Audio process tap on macOS 14.2 and later, WASAPI process loopback on Windows 10 2004 and later, and the PulseAudio or PipeWire default monitor on Linux. `@opengeni/desktop` runs it per page and streams its samples over the new `systemAudio` bridge capability, and stops it when the page navigates away, closes or the app quits.

  `@opengeni/sdk` adds `desktopSystemAudioSource`, which turns those samples into a `MediaStreamTrack` the recorder records as its own track, `displaySystemAudioSource` for the browser's shared tab or screen audio, and `defaultSystemAudioSource`, which picks the desktop helper when the app offers it. `RecorderOptions.systemAudioSource` overrides the choice, `RecorderPlatform.systemAudioKind` says which one a recorder uses, and capture failures are reported as the exported `RecorderCaptureError`. `useRecorder` from `@opengeni/react/recordings` exposes `systemAudioKind`.

- c194abb: The desktop app has a Settings → Computer use page that shows, in one place, what Opengeni may do on the computer. The Computer use switch comes first; under it are control the screen (with Screen Recording, Accessibility and Input Monitoring), Google Chrome through the Opengeni Browser extension, the Desktop, Documents and Downloads folders and the Excel add-in, then App-shots and the microphone. Each row has one switch or one action. Turning a switch on asks the system for its permissions in the same step, one after another as each is allowed, or opens the exact System Settings pane when macOS needs the person to change it there, and the row shows Allowed when they come back. A permission the person hasn't allowed is a calm line naming what's missing, not an error, with one Open System Settings action for the page (on the Computer use row, or the row's own for the microphone); red is only for real failures. Turning one off is enforced: with screen control off the app restarts its agent with `OPENGENI_AGENT_SCREEN_CONTROL=off`, and the agent then offers no desktop, reports no screen consent or macOS permission states, starts its browser controllers without a computer backend, asks for no grants, captures nothing and injects no input whatever the connection's consent says; with Chrome off the agent releases its Chrome native-messaging host and starts no attached-browser bridge; with the microphone off the app refuses every microphone request. The switches are on by default and persist in the app's data folder; a settings file that can't be read counts as everything off until a save replaces it (a damaged one is also copied to `.corrupt`). A save or restart that fails shows on its row. The desktop bridge gains `computerCapabilities`, and this-computer status gains `folders`. App-shots settings move from Settings → Machines to this page, which Machines now points to. The agent's `permissions` answer says it honours the screen-control switch; with an older agent the switch shows as unavailable. The `computer-use` page joins the client page list.

### Patch Changes

- dcbe25d: In the desktop app, the computer you're on is now **Computer use**: one on/off switch in Settings > Machines (and at the top of **Connect a machine**) instead of Turn on, Pause, Turn off and the old "Connecting …" card. It shows one state at a time: off (the same whether never set up, turned off, or removed from Machines), turning on, on, a calm "allow Opengeni in System Settings" line with **Open System Settings** while a macOS permission is still missing (not an error: files and commands work meanwhile), or a real problem in red with exactly one fix (**Sign in**, or **Try again** with the server's own message). Before, a computer removed from Machines kept saying "Connecting …" forever with "Couldn't reach the server" although the server had answered; now removal is detected and shows as off, and turning it on registers the computer again. Only a server that really can't be reached says so (new `ThisComputerErrorCode` values `removed` and `signed_out`; failed reads are classified by kind, and `ThisComputerDeps.readMachine` resolves null only when the server answered without the enrollment).

  Off is pause, so it survives restarts and keeps the registration. Turning on is the whole step: it resumes, re-registers or starts the agent as needed, then asks macOS for each missing permission in turn (the system prompt, or the exact System Settings list with the floating guide) and finishes by itself once they are granted; if the person comes back without allowing one, it stops asking until they choose **Open System Settings**. An agent already registered to the workspace from the web app's install command is adopted and shows as on with nothing to do; on macOS the app then runs that same agent as its own helper (same registration, its service turned off) when the app already holds the service's screen permissions or when a missing one is asked for, so one set of permissions, Opengeni's, covers app-shots and computer use. The service runs it again if the helper doesn't stay up, when the app quits, or at the next launch if the helper's program is gone, so the computer never has two agents or none. The sidebar shows a small notice only while computer use turns on, needs a permission, or has a problem. Inside the app, **Connect a machine** no longer offers downloads or **Open app and connect** for this computer; in a browser it is unchanged. `useThisComputer` gains `turnOn`, `turnOff`, `pending`, `asking` and `allowPermissions`; `ThisComputerStatus` gains `requestedPermissions`; `ThisComputerDeps` gains `hostServiceAgent` and `ThisComputer.summary()` gains `handsBackOnQuit`; `@opengeni/react/this-computer` exports `computerUseState`, `computerUsePermissionText` and `useComputerUse`, and the desktop app exports `DesktopComputerUseRow` and `useDesktopComputerUse`.

- 3a96b87: The page keeps keyboard focus when the window becomes active again. On macOS, after the app was hidden or the display slept, the page's first keystrokes were lost, so the first Control+Tab jumped straight to the next chat instead of showing the chat switcher.
- 8bd2c99: macOS asks about fewer privacy permissions. The desktop window grants the microphone (dictation, voice chats and meeting recordings) but no longer the camera, refuses USB, serial, HID and Bluetooth devices, and turns off Web Bluetooth; the app's own local pages get no permissions. On a Connected Mac whose agent works from the home folder, code search skips Library, Music, Pictures, Movies and the Trash unless a path names them, and each of Desktop, Documents and Downloads until the owner has allowed the app to open it. Repository discovery does the same as a safeguard. The Connected Machine instructions tell the agent not to scan those folders unasked.
- Updated dependencies [1988e97]
- Updated dependencies [c5974ea]
- Updated dependencies [15b4701]
- Updated dependencies [e3782bb]
- Updated dependencies [eb30cb4]
- Updated dependencies [4c6bf32]
- Updated dependencies [f3d19a2]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [6f6c356]
- Updated dependencies [cccd692]
- Updated dependencies [d6c7c4a]
- Updated dependencies [dca33ef]
- Updated dependencies [3b9f0e5]
- Updated dependencies [dcbe25d]
- Updated dependencies [31bca3c]
- Updated dependencies [1d5bc4e]
- Updated dependencies [6acfbd3]
- Updated dependencies [fb90446]
- Updated dependencies [0826dfd]
- Updated dependencies [bd57ea7]
- Updated dependencies [c307566]
- Updated dependencies [a97c71b]
- Updated dependencies [8bd2c99]
- Updated dependencies [406d1b9]
- Updated dependencies [2c34440]
- Updated dependencies [c992791]
- Updated dependencies [87d1b8a]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [d6c7c4a]
- Updated dependencies [68b195d]
- Updated dependencies [f9f0607]
- Updated dependencies [75348a5]
- Updated dependencies [cc319f3]
- Updated dependencies [314522c]
- Updated dependencies [3b1d8c1]
- Updated dependencies [ee4df07]
- Updated dependencies [7d419e2]
- Updated dependencies [83682c3]
- Updated dependencies [a9809ee]
- Updated dependencies [acac580]
- Updated dependencies [f3d19a2]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [b7a14bd]
- Updated dependencies [119f33d]
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
  - @opengeni/sdk@5.3.0
  - @opengeni/agent-host@5.3.0

## 5.2.1

### Patch Changes

- Updated dependencies [2d6484c]
  - @opengeni/sdk@5.2.0
  - @opengeni/agent-host@5.2.0

## 5.1.2

### Patch Changes

- Updated dependencies [5d377a7]
  - @opengeni/sdk@5.1.0
  - @opengeni/agent-host@5.1.0

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
