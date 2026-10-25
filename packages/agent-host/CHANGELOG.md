# @opengeni/agent-host

## 5.3.1

### Minor Changes

- dcbe25d: In the desktop app, the computer you're on is now **Computer use**: one on/off switch in Settings > Machines (and at the top of **Connect a machine**) instead of Turn on, Pause, Turn off and the old "Connecting …" card. It shows one state at a time: off (the same whether never set up, turned off, or removed from Machines), turning on, on, a calm "allow Opengeni in System Settings" line with **Open System Settings** while a macOS permission is still missing (not an error: files and commands work meanwhile), or a real problem in red with exactly one fix (**Sign in**, or **Try again** with the server's own message). Before, a computer removed from Machines kept saying "Connecting …" forever with "Couldn't reach the server" although the server had answered; now removal is detected and shows as off, and turning it on registers the computer again. Only a server that really can't be reached says so (new `ThisComputerErrorCode` values `removed` and `signed_out`; failed reads are classified by kind, and `ThisComputerDeps.readMachine` resolves null only when the server answered without the enrollment).

  Off is pause, so it survives restarts and keeps the registration. Turning on is the whole step: it resumes, re-registers or starts the agent as needed, then asks macOS for each missing permission in turn (the system prompt, or the exact System Settings list with the floating guide) and finishes by itself once they are granted; if the person comes back without allowing one, it stops asking until they choose **Open System Settings**. An agent already registered to the workspace from the web app's install command is adopted and shows as on with nothing to do; on macOS the app then runs that same agent as its own helper (same registration, its service turned off) when the app already holds the service's screen permissions or when a missing one is asked for, so one set of permissions, Opengeni's, covers app-shots and computer use. The service runs it again if the helper doesn't stay up, when the app quits, or at the next launch if the helper's program is gone, so the computer never has two agents or none. The sidebar shows a small notice only while computer use turns on, needs a permission, or has a problem. Inside the app, **Connect a machine** no longer offers downloads or **Open app and connect** for this computer; in a browser it is unchanged. `useThisComputer` gains `turnOn`, `turnOff`, `pending`, `asking` and `allowPermissions`; `ThisComputerStatus` gains `requestedPermissions`; `ThisComputerDeps` gains `hostServiceAgent` and `ThisComputer.summary()` gains `handsBackOnQuit`; `@opengeni/react/this-computer` exports `computerUseState`, `computerUsePermissionText` and `useComputerUse`, and the desktop app exports `DesktopComputerUseRow` and `useDesktopComputerUse`.

- c194abb: The desktop app has a Settings → Computer use page that shows, in one place, what Opengeni may do on the computer. The Computer use switch comes first; under it are control the screen (with Screen Recording, Accessibility and Input Monitoring), Google Chrome through the Opengeni Browser extension, the Desktop, Documents and Downloads folders and the Excel add-in, then App-shots and the microphone. Each row has one switch or one action. Turning a switch on asks the system for its permissions in the same step, one after another as each is allowed, or opens the exact System Settings pane when macOS needs the person to change it there, and the row shows Allowed when they come back. A permission the person hasn't allowed is a calm line naming what's missing, not an error, with one Open System Settings action for the page (on the Computer use row, or the row's own for the microphone); red is only for real failures. Turning one off is enforced: with screen control off the app restarts its agent with `OPENGENI_AGENT_SCREEN_CONTROL=off`, and the agent then offers no desktop, reports no screen consent or macOS permission states, starts its browser controllers without a computer backend, asks for no grants, captures nothing and injects no input whatever the connection's consent says; with Chrome off the agent releases its Chrome native-messaging host and starts no attached-browser bridge; with the microphone off the app refuses every microphone request. The switches are on by default and persist in the app's data folder; a settings file that can't be read counts as everything off until a save replaces it (a damaged one is also copied to `.corrupt`). A save or restart that fails shows on its row. The desktop bridge gains `computerCapabilities`, and this-computer status gains `folders`. App-shots settings move from Settings → Machines to this page, which Machines now points to. The agent's `permissions` answer says it honours the screen-control switch; with an older agent the switch shows as unavailable. The `computer-use` page joins the client page list.

### Patch Changes

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

## 5.2.1

### Patch Changes

- Updated dependencies [2d6484c]
  - @opengeni/sdk@5.2.0

## 5.1.2

### Patch Changes

- Updated dependencies [5d377a7]
  - @opengeni/sdk@5.1.0

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

## 4.8.0

### Patch Changes

- Updated dependencies [3089aaf]
- Updated dependencies [e2a641c]
  - @opengeni/sdk@4.8.0

## 4.7.2

### Patch Changes

- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
  - @opengeni/sdk@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/sdk@4.7.1

## 4.7.0

### Patch Changes

- @opengeni/sdk@4.7.0

## 4.6.1

### Patch Changes

- Updated dependencies [e7ca55f]
  - @opengeni/sdk@4.6.0

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

## 4.4.1

### Minor Changes

- a1a907c: A product can let its own branded build of the Opengeni Browser Chrome extension reach the person's agent. Set `browserExtensionIds` (Chrome's 32-letter extension IDs) in the desktop kit's config, or in `ThisComputer`'s options; the agent then lists those extensions next to Opengeni Browser in the Chrome Native Messaging host it registers. Standalone installs read the same list from `OPENGENI_AGENT_BROWSER_EXTENSION_IDS` when running `opengeni-agent service install`. This needs an agent built from this release or later.

### Patch Changes

- Updated dependencies [524ddde]
- Updated dependencies [b58a428]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [d295544]
- Updated dependencies [614c744]
- Updated dependencies [81a516c]
- Updated dependencies [60e031c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [84c8b32]
- Updated dependencies [84b1a18]
  - @opengeni/sdk@4.4.0

## 4.3.1

### Minor Changes

- 2963eca: App-shots in the desktop app. When turned on in Settings → Machines, a shortcut (both Command keys on macOS by default) attaches the window you are looking at in another app to the chat you are using: a screenshot plus the window's app, title and the text it shows, including text scrolled out of view. Nothing is sent until you send it, and the attachment can be removed first. The agent receives the window's text as untrusted data inside that message only, so earlier turns stay unchanged. When your computer is connected to the workspace, the agent also learns which machine and window it was, so it can keep working in that window with computer tools; for a browser window it also gets the page address and the browser profile connected through the Opengeni extension, so it can continue in that tab with browser tools. Uploads accept an optional `appShot` description for image files (`uploadFile` in the SDK), and `useFileAttachments` gains `addAppShot`. macOS only for now; Windows and Linux plug into the same capture boundary.

### Patch Changes

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

## 4.2.0

### Minor Changes

- 5252d01: Embedding products can show their own name everywhere people look.

  - `@opengeni/react`: a `productName` prop on `OpenGeniProvider` and `OpenGeniMessagesProvider` (and `createOpenGeniText`) fills `{product}` in every built-in string that names the product, such as credit labels and recovery notices. Default "Opengeni".
  - `@opengeni/agent-host`: `browserExtension: false` keeps an app's own agent from registering as the Opengeni Browser extension's native host, and removes a registration it made earlier, so another agent on the same computer keeps the extension.
  - The agent's browser and computer helpers now run as `browserd` and `computer-native`, so Activity Monitor and Task Manager show no product name under an app that runs the agent under its own name. Older names beside an installed agent are still found.

### Patch Changes

- Updated dependencies [641e179]
- Updated dependencies [8c38fe4]
- Updated dependencies [e018445]
- Updated dependencies [47eeb80]
  - @opengeni/sdk@4.2.0

## 4.1.3

### Patch Changes

- Updated dependencies [404e017]
  - @opengeni/sdk@4.1.2

## 4.1.1

### Patch Changes

- Updated dependencies [afff3f9]
- Updated dependencies [04019de]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/sdk@4.1.0

## 4.0.4

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
