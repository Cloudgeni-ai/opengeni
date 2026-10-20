# @opengeni/agent-host

## 4.3.1

### Patch Changes

- Updated dependencies [579239a]
- Updated dependencies [70f0522]
- Updated dependencies [b95784c]
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
