# @opengeni/react-native

## 1.5.0

### Minor Changes

- f44a0c8: Add an Expo config plugin for system voice calls: it sets the Info.plist keys CallKit needs (`audio` and `voip` background modes, `INStartCallIntent`, microphone purpose, optional Siri app-name synonyms) and generates an App Intent with App Shortcut phrases, so Siri, Spotlight, the Shortcuts app and the Action button can start a call with the agent. `OpenGeniCallLauncher.requestStart()` is the public native entry point.
- e7f6a53: Native chat media at web parity. `@opengeni/react-native/timeline/previews` adds `createNativePreviewRenderers`: retained-file images load inline (tap for a zoomable full-screen view), and `opengeni-html` / `opengeni-site` previews render in a sandboxed web view sized to their content, with the web's animated "Preparing preview…" surface while the assistant is still writing them, plus incomplete and error states. `createWebMarkdownRenderer` gains `renderImage` and `renderInteractiveBlock`, plain image URLs load, and wide tables scroll sideways with an edge hint. `@opengeni/react/native-previews` exposes the DOM-free pieces (`inlineHtmlDocument`, `previewLoadingDocument`, `loadSiteSnapshot`, `paintPreviewLoading`).
- 46f6181: Localizable native session surfaces: every string the native timeline, session screen, signals, actions, queue dock and dictation strip draw now comes from `NativeTimelineMessages` (English defaults), overridable with `NativeTimelineMessagesProvider` or the session screen's `timelineMessages` prop. `NativeSessionScreen` also gains `renderComposer`, which receives the exact `SessionComposer` props so a host can restyle the composer or supply its own.
- ae0d52d: `@opengeni/react-native` is now published to npm. It adds realtime voice calls with your agent:

  - `useNativeSessionRealtime` runs the web's `useSessionRealtime` (same SDK controller, admission rules and lifecycle recovery) on native WebRTC.
  - `useNativeRealtimeCall` keeps a system call (CallKit on iOS) and the voice session in lockstep, mirroring hang-up and mute both ways.
  - `OpenGeniNativeCallView` is a full-screen call screen in the web theme.
  - `createExpoCallAdapter` (from `./expo`) uses the package's own Expo module, which autolinking picks up: CallKit calls listed in Recents, an audio session that keeps working with the phone locked and follows AirPods, and start requests from Siri, the Phone app and a home-screen action.
  - The opt-in `./webrtc` entry wires `react-native-webrtc` (an optional peer) to the voice controller and the call audio session.

### Patch Changes

- a60eae4: `useNativeRealtimeCall` keeps talking when the system refuses the call (no CallKit in the region, the simulator): voice starts as an in-app call, and the new `systemCall` field says whether the system shows it.
- 6b72e46: Document the `voip` background mode that CallKit requires for system calls, warn when the system refuses a call instead of failing silently, and use a host-neutral connection error message.
- 568b8df: The session timeline loads older history as the reader scrolls up (keeping their place), collapses long sent messages behind "Show more" like the web, and lets a drag take over from follow while a turn is live instead of snapping back to the end.
- Updated dependencies [e03f1ff]
- Updated dependencies [14a9340]
- Updated dependencies [d8a4e8e]
- Updated dependencies [f36484a]
- Updated dependencies [561c701]
- Updated dependencies [7f2446f]
- Updated dependencies [4532435]
- Updated dependencies [851cbdc]
- Updated dependencies [8017d94]
- Updated dependencies [ce7b403]
- Updated dependencies [285968f]
- Updated dependencies [121f6ed]
- Updated dependencies [f3aa7f2]
- Updated dependencies [334c470]
- Updated dependencies [f7d53b2]
- Updated dependencies [0c6f5c4]
- Updated dependencies [c13d080]
- Updated dependencies [061ae01]
- Updated dependencies [6313dd8]
- Updated dependencies [e7f6a53]
- Updated dependencies [38b1ba1]
- Updated dependencies [6960770]
- Updated dependencies [63bf721]
- Updated dependencies [78c28ca]
- Updated dependencies [d6ea462]
- Updated dependencies [71c42bf]
- Updated dependencies [5cb9c49]
- Updated dependencies [588b90f]
- Updated dependencies [541a359]
- Updated dependencies [2a19988]
- Updated dependencies [a390b9e]
- Updated dependencies [b9ae380]
- Updated dependencies [7852cda]
- Updated dependencies [a51c96e]
- Updated dependencies [7f3f19f]
- Updated dependencies [7bf1a02]
- Updated dependencies [27db84b]
  - @opengeni/contracts@1.5.0
  - @opengeni/sdk@1.5.0
  - @opengeni/react@1.5.0
