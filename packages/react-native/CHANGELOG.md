# @opengeni/react-native

## 3.4.0

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [60191f6]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/contracts@3.4.0
  - @opengeni/sdk@3.4.0
  - @opengeni/react@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/sdk@3.3.0
  - @opengeni/contracts@3.3.0
  - @opengeni/react@3.3.0

## 3.2.2

### Patch Changes

- Updated dependencies [c30cf85]
- Updated dependencies [a0c35a1]
  - @opengeni/react@3.2.0
  - @opengeni/contracts@3.2.0
  - @opengeni/sdk@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies [17d61c6]
- Updated dependencies [74a259d]
- Updated dependencies [1e67711]
- Updated dependencies [0bdb953]
- Updated dependencies [79af429]
- Updated dependencies [9f92b60]
- Updated dependencies [e332bc1]
- Updated dependencies [877c70d]
- Updated dependencies [86df483]
  - @opengeni/contracts@3.1.0
  - @opengeni/sdk@3.1.0
  - @opengeni/react@3.1.0

## 3.0.0

### Patch Changes

- 11e8fe5: The native session composer now removes a message's attachments as soon as Send is acknowledged locally, the same as the web composer. Before, the tray kept the photos until the server accepted the message, so tapping Send again in that window re-sent the same files as an extra file-only message. Only the files that send captured are removed, so attachments added while it is in flight stay for the next message.
- Updated dependencies [99ab991]
- Updated dependencies [9a15dda]
- Updated dependencies [be83e73]
- Updated dependencies [1c1aa30]
- Updated dependencies [501bb83]
- Updated dependencies [664368a]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [bfa1754]
- Updated dependencies [f7abc0b]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
- Updated dependencies [d367818]
  - @opengeni/react@3.0.0
  - @opengeni/sdk@3.0.0
  - @opengeni/contracts@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [2ea5f7b]
- Updated dependencies [e8d18da]
  - @opengeni/contracts@2.0.1
  - @opengeni/sdk@2.0.1
  - @opengeni/react@2.0.1

## 2.0.0

### Minor Changes

- 445baf4: Default generic native calls to fresh sessions while preserving explicit session entry. Add non-authoritative selected-session context and exact Send/Steer delivery-to-result tracking without transferring the call.
- 9701372: Agents can notify another member of their workspace. `notify_user` takes an optional `recipient` (email or member name); it reaches that member only while they allow other members' agents to notify them in that workspace, a per-person setting that is off by default (`GET`/`PUT /v1/workspaces/:workspaceId/inbox/member-notifications`, `getMemberNotifications` and `updateMemberNotifications` in the SDK). Otherwise the agent gets a clear refusal, as it does for non-members and for sessions that work for no person. Inbox items now carry `sender` (who the notification came from) and `sessionAvailable`: another member's private session is never linked, titled or opened from the inbox or the phone notification. Inbox items are kept per recipient, so one key can reach the owner and a teammate separately, and `notification_withdraw` can withdraw one member's copy.
- 3a3fb43: Links in native timelines, notes and previews can open inside the host app. `OpenGeniReactNativeAdapters` takes an optional `links: { openUrl(url) }` adapter, and the new `useOpenNativeLink()` hook returns it, falling back to `Linking.openURL`. `useNativeAgentCall().callSession(sessionId, workspaceId?)` now accepts the session's own workspace, for sessions opened outside the current one.
- f44a0c8: Add an Expo config plugin for system voice calls: it sets the Info.plist keys CallKit needs (`audio` and `voip` background modes, `INStartCallIntent`, microphone purpose, optional Siri app-name synonyms) and generates an App Intent with App Shortcut phrases, so Siri, Spotlight, the Shortcuts app and the Action button can start a call with the agent. `OpenGeniCallLauncher.requestStart()` is the public native entry point.
- e7f6a53: Native chat media at web parity. `@opengeni/react-native/timeline/previews` adds `createNativePreviewRenderers`: retained-file images load inline (tap for a zoomable full-screen view), and `opengeni-html` / `opengeni-site` previews render in a sandboxed web view sized to their content, with the web's animated "Preparing preview…" surface while the assistant is still writing them, plus incomplete and error states. `createWebMarkdownRenderer` gains `renderImage` and `renderInteractiveBlock`, plain image URLs load, and wide tables scroll sideways with an edge hint. `@opengeni/react/native-previews` exposes the DOM-free pieces (`inlineHtmlDocument`, `previewLoadingDocument`, `loadSiteSnapshot`, `paintPreviewLoading`).
- df46749: The native composer can start a voice call: with a `call` prop, an empty, idle composer's trailing action becomes a call button (audio lines; call-green when that conversation is already on a call), so a new conversation can begin as a call. `NativeSessionScreen` passes it through its composer slots. Hosts can also replace the rotating loading copy beside the orb with `loadingPhrases` in the native timeline messages, matching the web timeline's loading `phrases` option. The call button's labels are the new `startCall` and `returnToCall` messages.
- 46f6181: Localizable native session surfaces: every string the native timeline, session screen, signals, actions, queue dock and dictation strip draw now comes from `NativeTimelineMessages` (English defaults), overridable with `NativeTimelineMessagesProvider` or the session screen's `timelineMessages` prop. `NativeSessionScreen` also gains `renderComposer`, which receives the exact `SessionComposer` props so a host can restyle the composer or supply its own.
- ae0d52d: `@opengeni/react-native` is now published to npm. It adds realtime voice calls with your agent:

  - `useNativeSessionRealtime` runs the web's `useSessionRealtime` (same SDK controller, admission rules and lifecycle recovery) on native WebRTC.
  - `useNativeRealtimeCall` keeps a system call (CallKit on iOS) and the voice session in lockstep, mirroring hang-up and mute both ways.
  - `OpenGeniNativeCallView` is a full-screen call screen in the web theme.
  - `createExpoCallAdapter` (from `./expo`) uses the package's own Expo module, which autolinking picks up: CallKit calls listed in Recents, an audio session that keeps working with the phone locked and follows AirPods, and start requests from Siri, the Phone app and a home-screen action.
  - The opt-in `./webrtc` entry wires `react-native-webrtc` (an optional peer) to the voice controller and the call audio session.

### Patch Changes

- 04ebc42: A session whose next turn the runtime refused to start (an admission block, such as a rejected database claim) no longer reads as "Waiting on you" with nothing to answer. It now reads as "Stuck" in the session header, lists, hover details, sub-agent rows and the timeline divider, on the web and in the native app. The web session notice is titled "Stuck" and, for a rejected claim, says nothing is needed from the person. The native session screen shows a matching card with a Try again action (Resume), and its composer offers Send instead of Stop while the session is stuck. Session list entries now carry `admissionBlock`, and the SDK's `Session` type gains the optional `admissionBlock`. New helpers `sessionDisplayStatus` and `sessionAdmissionBlocked` return the display status `blocked`, and the native timeline messages gain `stuckTitle`, `stuckBody`, `stuckAccessBody`, `stuckRetry` and `stuckRetryFailed` for hosts that swap copy.
- 5f8d2e2: A turn blocked on model subscription capacity now reads "Limit reached" on its work row, with one quiet line saying it continues automatically, instead of a long separate warning. Once the turn resumes or settles the warning is gone, and "Worked for" no longer counts the time spent waiting for capacity. The `waiting_capacity` session status label is now "Limit reached". Waits that need a person (an ineligible pinned account, a disallowed model, accounts disabled for allocation, or an account that needs reconnecting) keep their recorded reason.
- c960696: Long orchestration runs no longer stack identical "Agent update / Worked for / Waited" rows. Two or more consecutive quiet cycles (routine input, work without a visible reply, a finished wait) fold into one row such as "8 updates over 5h 54m · 30 steps", with the latest wait reason under it on the web. Expanding it shows the original rows unchanged. Visible replies, people's messages and the turns they open, failed turns, approvals, live work and the current wait are never folded.
- a876a1d: `useOpenNativeLink` moves to its own module so the native environment module no longer imports `react-native` at runtime, and the API derives the session MCP permission identity through the approved `@opengeni/runtime/workspace-tool-gateway` entrypoint instead of the runtime barrel.
- a60eae4: `useNativeRealtimeCall` keeps talking when the system refuses the call (no CallKit in the region, the simulator): voice starts as an in-app call, and the new `systemCall` field says whether the system shows it.
- db0fdfc: A call started from a brand-new session shows the host's untitled label instead of an ID-derived session reference.
- 6b72e46: Document the `voip` background mode that CallKit requires for system calls, warn when the system refuses a call instead of failing silently, and use a host-neutral connection error message.
- 7279f9a: The scroll-edge cover under a floating Liquid Glass composer now actually paints. It was an SVG gradient that drew nothing on device, so conversation text still showed through the glass and between the composer and the screen edge. It is now drawn with plain views: a short fade into the page color just above the composer, then a solid page-color block behind and below it.
- 2f8ae60: The native timeline shows each live progress note once: while a running turn's work row is open, the copies of its notes above the row fold away, as on the web, and the row stays where the reader tapped it. `TurnSummary` gains `onOpenStateChange`. Under a floating Liquid Glass composer, the conversation now fades into the page color just above the composer and is covered behind and below it, so text no longer shows through the glass or between the composer and the screen edge.
- 9a78a48: The native app shows and changes the person's pinned chats, the same personal pins as the web. The sessions list has a Pinned section above the projects, the home list shows pins first as the web home does, and both load every pin through the pin-aware session page. A long press on a row (or its accessibility action) pins or unpins it: the row moves at once and the server's answer settles it. `SessionRow` and `SessionRowList` gain `onTogglePin`, and pinned rows show a small pin mark. `@opengeni/react` adds `applySessionPinToLists`, which moves a session between the pinned and ordinary lists and ignores pin answers older than the row shown. The native messages gain `pinned` and `pinFailed`.
- 568b8df: The session timeline loads older history as the reader scrolls up (keeping their place), collapses long sent messages behind "Show more" like the web, and lets a drag take over from follow while a turn is live instead of snapping back to the end.
- Updated dependencies [fc57bd2]
- Updated dependencies [04ebc42]
- Updated dependencies [e03f1ff]
- Updated dependencies [14a9340]
- Updated dependencies [c2f4153]
- Updated dependencies [d4c17b3]
- Updated dependencies [de2d721]
- Updated dependencies [055015d]
- Updated dependencies [d8a4e8e]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [f36484a]
- Updated dependencies [5f8d2e2]
- Updated dependencies [dfee983]
- Updated dependencies [6861501]
- Updated dependencies [c69d74d]
- Updated dependencies [561c701]
- Updated dependencies [7f2446f]
- Updated dependencies [bfed4f1]
- Updated dependencies [4532435]
- Updated dependencies [851cbdc]
- Updated dependencies [4f18b7e]
- Updated dependencies [c960696]
- Updated dependencies [c9f2c11]
- Updated dependencies [dc38882]
- Updated dependencies [fb298ad]
- Updated dependencies [f96605f]
- Updated dependencies [496ce55]
- Updated dependencies [c08dfcd]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [8017d94]
- Updated dependencies [64c4dd3]
- Updated dependencies [ce7b403]
- Updated dependencies [445baf4]
- Updated dependencies [285968f]
- Updated dependencies [121f6ed]
- Updated dependencies [f3aa7f2]
- Updated dependencies [5b4a738]
- Updated dependencies [5baab79]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [f7d53b2]
- Updated dependencies [0c6f5c4]
- Updated dependencies [c13d080]
- Updated dependencies [061ae01]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [6313dd8]
- Updated dependencies [945490f]
- Updated dependencies [4d8eb5e]
- Updated dependencies [8e878ac]
- Updated dependencies [ea7428d]
- Updated dependencies [9701372]
- Updated dependencies [0c763f2]
- Updated dependencies [bc40348]
- Updated dependencies [5eb1c32]
- Updated dependencies [da01634]
- Updated dependencies [35fb6fd]
- Updated dependencies [ab3306a]
- Updated dependencies [4cb80a9]
- Updated dependencies [e7f6a53]
- Updated dependencies [9a78a48]
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
- Updated dependencies [78c28ca]
- Updated dependencies [d6ea462]
- Updated dependencies [71c42bf]
- Updated dependencies [5cb9c49]
- Updated dependencies [588b90f]
- Updated dependencies [541a359]
- Updated dependencies [2a19988]
- Updated dependencies [a390b9e]
- Updated dependencies [8f02eb2]
- Updated dependencies [945c247]
- Updated dependencies [2fb5ec6]
- Updated dependencies [b9ae380]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [5441ac9]
- Updated dependencies [945c247]
- Updated dependencies [322f26c]
- Updated dependencies [945c247]
- Updated dependencies [cb9e426]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [5cb6d71]
- Updated dependencies [732a788]
- Updated dependencies [8cf9e0a]
- Updated dependencies [7852cda]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [a51c96e]
- Updated dependencies [7f3f19f]
- Updated dependencies [7ce535f]
- Updated dependencies [ef1f78d]
- Updated dependencies [35fb6fd]
- Updated dependencies [35fb6fd]
- Updated dependencies [7bf1a02]
- Updated dependencies [27287ee]
- Updated dependencies [a13bf1a]
- Updated dependencies [27db84b]
- Updated dependencies [615480c]
- Updated dependencies [2499dd2]
- Updated dependencies [945c247]
- Updated dependencies [c676ae8]
- Updated dependencies [a91718c]
  - @opengeni/contracts@2.0.0
  - @opengeni/sdk@2.0.0
  - @opengeni/react@2.0.0
