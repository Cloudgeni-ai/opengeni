# @opengeni/react-native

Opengeni agents in a React Native or Expo app: the session timeline and composer adapters, voice dictation, and realtime voice calls with your agent. Everything runs on the same `@opengeni/sdk` and `@opengeni/react` controllers as the web, so behavior matches the web app.

```sh
npx expo install @opengeni/react-native @opengeni/react @opengeni/sdk
```

## Session surfaces

Wrap the app in `OpenGeniReactNativeProvider` with adapters (ready-made Expo ones come from `@opengeni/react-native/expo`), then drive a session with `useOpenGeniNativeSession` and render it with the components in `@opengeni/react-native/timeline`.

```tsx
import { OpenGeniReactNativeProvider } from "@opengeni/react-native";
import { createExpoOpenGeniAdapters } from "@opengeni/react-native/expo";

<OpenGeniReactNativeProvider adapters={createExpoOpenGeniAdapters({ persistence })}>
  {children}
</OpenGeniReactNativeProvider>;
```

To reopen a recently viewed conversation instantly, keep reads for the signed-in
person's client with `useRetainedReads(client)` from `@opengeni/react/session`
in a component that stays mounted while they are signed in. The screen then
draws the conversation as it was left, with no spinner, and refreshes it in the
background. Only do this when each signed-in person gets their own client
object (a new client on sign-in, sign-out and account switch); the kept view is
in memory only and is dropped when the client changes.

```tsx
import { useRetainedReads } from "@opengeni/react/session";

function SignedIn({ client, children }) {
  useRetainedReads(client);
  return children;
}
```

If the people using your app should not have to choose between queueing and
steering, pass `busySend: "steer"` to `useOpenGeniNativeSession`. A normal Send
while the agent works is then read as soon as the agent can, usually within
seconds, instead of waiting for the whole turn: a reply it is still writing
stops and it answers with your message in mind, and running tools are not cut
off. The message simply
appears in the conversation. People see one Send and nothing to learn: the
server decides at arrival whether the message steers the running turn or
starts a new one, so a stale screen never queues it behind the turn. The
shared session screen shows no Queue choice beside it and no Queue or Steer
words (a message sent while the workstream is paused waits and shows as a
waiting message). Pass `offerQueue: true` as well to offer Queue next to Send.
Under the default `busySend: "queue"` the screen offers Steer next to Send.

Above the composer, `NativeSessionScreen` shows how the agent works: chips for
the session goal, helper agents and running commands. For people to whom a
paused goal or a count of helper agents means nothing, pass
`agentSignals={false}`. Queued messages, approvals and the agent's questions
still show, turn rows show only their status, and an automation run shows as
its one line and its answer.
To hide only some of it, pass an object of switches (`goal`, `agents`,
`commands`, `turnDetail`), each `true` unless set: `agentSignals={{ goal: false }}`
hides the goal chip and keeps queued messages, helper agents and your turn-row
facets.

An automation run reads as one line saying what happened (the automation's
name and what its event says), never its instructions, and a run whose answer
is exactly `NO_REPLY` is not drawn.

```tsx
<NativeSessionScreen controller={controller} agentSignals={false} />
```

To lead the live "Working" / "Waiting" / "Paused" turn row with your own mark,
such as a small animated mascot, pass `renderLiveMark` to `NativeSessionScreen`
(or `MessageTimeline`). It receives the row's state (`working`, `waiting` with
`waitingOn: "you"` for an approval or question, or `paused`) and is no longer
drawn once the turn settles. Keep it about 20 pt tall; it is hidden from
screen readers. The default is no mark.

```tsx
<NativeSessionScreen
  controller={controller}
  renderLiveMark={(state) => <Mascot state={state.kind} />}
/>
```

### Model levels

To give people two or three named levels instead of every model, put
`ModelLevelControl` in the composer's `options`, where you would put the model
pill. Each level is one catalog model at one reasoning effort and may offer
Ultrafast; the levels are the same `ModelLevel` objects as on web
(`@opengeni/react` `modelPickerProps.levels`).

```tsx
import { ModelLevelControl } from "@opengeni/react-native/timeline";

const levels = [
  { id: "standard", label: "Standard", model: "example/everyday", effort: "high" },
  { id: "thorough", label: "Thorough", model: "example/frontier", effort: "high", ultrafast: true },
] as const;

<NativeSessionScreen
  controller={controller}
  composer={{
    options: (
      <ModelLevelControl
        levels={levels}
        models={models}
        model={model}
        effort={effort}
        latencyMode={latencyMode}
        onModelChange={setModel}
        onEffortChange={setEffort}
        onLatencyModeChange={setLatencyMode}
        onSelectionFeedback={(kind) => haptics(kind)}
        fallback={<YourModelPill />}
      />
    ),
  }}
/>;
```

Tap or swipe the control to change level. Ultrafast shows only on levels with
`ultrafast: true` whose model can run it, and turns on only when people press
and hold the control until the charge fills (on the last level, pushing past
the end works too); screen readers get "Turn on Ultrafast" as an action. `onSelectionFeedback` reports `level`, `armed` (the
charge is full) and `ultrafast` so you can play haptics. Levels whose model the
workspace cannot run are left out; with none left, `fallback` is shown. A chat
on another model keeps it, and the control shows that model's name until a
level is picked. On a new-chat screen pass `startOnFirstLevel` so the chat
starts on the first level instead of the workspace default. To keep the full picker for some people, render your model
pill instead.

### Approval cards

Each pending approval shows a review card above the composer. On its own the
card can only show the tool's title and its arguments, which reads poorly for a
tool whose arguments are only identifiers. Pass `loadReview` to
`NativeSessionScreen` (or `ApprovalStrip`) to show a readable review instead:
the same hook and the same `ToolActionReview` as the web `ApprovalSurface`.
Load the server's review with `client.getToolActionReview`, or write your own:
a plain title, its consequence, and only the fields worth reading (`fields: []`
shows none). The raw arguments stay behind Details unless `detailsAvailable` is
`false`.

```tsx
import { pendingApprovalReview } from "@opengeni/react/approval-review-model";

<NativeSessionScreen
  controller={controller}
  loadReview={async (approval) => {
    if (approval.display?.toolName !== "move_card") return null; // standard card
    const { cardId } = approval.arguments as { cardId: string };
    const card = await api.cards.get(cardId);
    return {
      ...pendingApprovalReview(approval, { formatToolName: (name) => name, approveLabel: "Move" }),
      title: `Move “${card.title}” to Done?`,
      consequence: "The card leaves In progress and its assignee is told it is finished.",
      fields: [],
      moreFields: 0,
    };
  }}
/>
```

The review only changes what the card says; the approval decided is always the
one the agent asked for, and a review whose `id` is not the approval's is
ignored. While the review loads, the card shows the tool's title and holds
Approve (Reject still works). Resolving `null`, or rejecting with a 404
`OpenGeniApiError`, keeps the standard card. Any other failure shows the
standard card, still decidable, with Try again. `availableActions` decides
whether Approve is offered, and `approvedBy` / `accountOwnerLabel` say who may
approve. A question from the tool's MCP server is never read as a review.

### Labels and languages

The native components read their text from the same catalog as
`@opengeni/react` (native-only text lives under `native.*` keys). Wrap the app in
`OpenGeniMessagesProvider` from `@opengeni/react/messages` with your `locale` and
`messages`; see the `@opengeni/react` README for keys, plurals and fallback.

```tsx
import { OpenGeniMessagesProvider } from "@opengeni/react/messages";

<OpenGeniMessagesProvider locale="nb" messages={norwegian}>
  <OpenGeniReactNativeProvider adapters={adapters}>{children}</OpenGeniReactNativeProvider>
</OpenGeniMessagesProvider>;
```

The per-surface label props and providers (`NativeTimelineMessagesProvider`,
`labels` on the timeline and call components) still override individual
strings. Their defaults are now functions of the translator
(`defaultNativeTimelineMessages(t)`, `DEFAULT_OPENGENI_NATIVE_LABELS(t)`), so
pass `useOpenGeniText()` when you build on them.

## Voice calls with your agent

A call is the web's realtime voice session on native WebRTC, reported to the system as a phone call (CallKit on iOS). It keeps working with the phone locked, follows AirPods and CarPlay, shows in the Phone app's recents, and ends from the lock screen or a headset. On Android the same adapter sets up the phone's call audio (communication mode, audio focus, and the loudspeaker or a connected headset) without a system call screen.

```sh
npx expo install react-native-webrtc
```

```tsx
import {
  OpenGeniNativeCallView,
  useNativeRealtimeCall,
  useNativeSessionRealtime,
} from "@opengeni/react-native";
import { createExpoCallAdapter } from "@opengeni/react-native/expo";
import {
  connectCallAudioToWebRtc,
  createReactNativeWebRtcAdapter,
} from "@opengeni/react-native/webrtc";

const webrtc = createReactNativeWebRtcAdapter();

function AgentCall({ session }: { session: SessionInputs }) {
  const call = useMemo(() => createExpoCallAdapter(), []);
  useEffect(() => (call ? connectCallAudioToWebRtc(call) : undefined), [call]);
  // The same inputs the web's useSessionRealtime takes, plus native WebRTC.
  const realtime = useNativeSessionRealtime({ ...session, webrtc });
  const agentCall = useNativeRealtimeCall({ realtime, call, title: session.title });
  return <OpenGeniNativeCallView call={agentCall} title={session.title} />;
}
```

- `useNativeSessionRealtime` takes the same session inputs as `useSessionRealtime` from `@opengeni/react/session-realtime` (client, workspace, session, status, control, events). Pick the voice model with `useRealtimeModelSelection`. Native voice supports the WebRTC models; check with `nativeRealtimeModelSupported`.
- `useNativeRealtimeCall` starts and ends the system call with the voice session and mirrors mute both ways. Without a call adapter, voice still works without a system call; on Android, `systemCall` stays false because there is no call screen.
- When a live call is silent on one side, `notice` says why and the call view shows it: the microphone picks up no sound at all, or a reply arrived but did not play. The realtime snapshot carries the same as the `no_input_audio` and `output_silent` diagnostics.
- Calls started outside the app (Siri, Phone recents, a home-screen quick action whose type ends in `.call`, a voice command) arrive as `startRequested` events, or through `takePendingStartRequest()` after a cold launch. The host decides which session they talk to. A request that names a chat carries its `target` session and its `workspaceId`; `callFromOutside(sessionId, workspaceId)` calls a session in another workspace of the signed-in account. Requests wait natively until JavaScript takes them (for up to a minute), so a request that launched the app is not lost to an early listener, and each starts once.
- **Voice commands:** `adapter.setCallCommands([{ id, workspaceId, sessionId, name }])` tells the system which chats the person can call by name. On iOS the generated intent offers them as its chat parameter ("Call Research in Opengeni"), and the app's App Shortcuts are refreshed; on Android each becomes a launcher shortcut (touch and hold the app icon), and `adapter.pinCallCommand(command)` asks the launcher to put one on the home screen. Write only the signed-in account's commands, and an empty list on sign-out. Commands are opt-in per chat: never pass every chat.
- `NativeAgentCallProvider` defaults generic outside calls to a fresh realtime session; `resolveOutsideCall` can preserve a host's explicit preferences. An explicit session request still wins. Generic calls keep a generic system-recents handle; calling a named session records that session. Selecting another session as conversational context does not change the active voice session.

### iOS configuration

Expo autolinking picks up this package's call module. Add the config plugin to the app config; it sets the Info.plist keys calls need and generates a Siri/Shortcuts action for starting a call:

```json
{
  "plugins": [
    [
      "@opengeni/react-native",
      {
        "call": {
          "title": "Call your agent",
          "phrases": ["Call {app}", "Talk to {app}"],
          "alternativeAppNames": ["Agent"]
        }
      }
    ]
  ]
}
```

- **Info.plist:** `UIBackgroundModes` gains `audio` and `voip` (CallKit refuses call requests from an app without `voip`, so the call would still talk but never appear as a system call), `NSUserActivityTypes` gains `INStartCallIntent` (redial from Phone recents), and `NSMicrophoneUsageDescription` is set unless the app already sets it.
- **App Intent and App Shortcuts:** a generated Swift file in the app target declares a "start a call" intent and its Siri phrases. `{app}` stands for the app's name and must appear exactly once in each phrase (Siri requires it). Without any setup the action then works from Siri, Spotlight and the Shortcuts app, and can be assigned to the Action button. The intent opens the app and arrives as a `startRequested` event with no target, so the host chooses the session. It requires an unlocked device (`authenticationPolicy = .requiresAuthentication`): from a locked phone Siri asks the person to unlock first.
- **`chatPhrases`** (default `["Call {chat} in {app}", "Talk to {chat} in {app}"]`): the phrases for voice commands. `{chat}` (exactly once) stands for a command's name and `{app}` for the app's name. The intent's optional chat parameter lists exactly the commands set with `setCallCommands`, so each command appears as its own App Shortcut. Pass `[]` to offer none. `chatTitle` and `chatSummary` (`"Call {chat}"`) label the parameter in Shortcuts.
- **Calls from Phone recents and "call … using" requests** (`INStartCallIntent`) on a locked phone wait for the person to unlock it, for up to 30 seconds, and are then dropped. "Locked" is what iOS reports as protected data being unavailable: with a passcode that starts about 10 seconds after the screen locks, so a request in those first seconds still starts, and a phone without a passcode never counts as locked. In CarPlay a locked phone asks for the unlock as well.
- **`alternativeAppNames`:** extra names Siri accepts for the app (`INAlternativeAppNames`), for example the agent's own name, so "Call Agent" works in an app called something else.
- Set `"appIntents": false` inside `call` to skip the generated intent.
- **`androidSystemCall: true`** (inside `call`): Android calls become system calls, a self-managed Telecom call with a call notification and a foreground service that keeps it going with the screen off, so a cellular call holds it and Bluetooth headsets and watches answer and hang up. When the app uses `expo-notifications`, agents' calls also ring the phone like a phone call: the server's high-priority push shows the incoming-call notification and a full-screen ring screen on the lock screen, and answering hands the call to the same `incoming` events as on iOS. The plugin adds the permissions this needs (`MANAGE_OWN_CALLS`, the phone-call and microphone foreground service types, notifications and full-screen intents), the service, the ring screen and the messaging service. Play asks apps that declare these to explain them, so it is off by default; without it, Android calls play through the phone's call audio without a system call.
- **`androidMessagingService: "app"`** (inside `call`, with `androidSystemCall: true`): the app delivers agents' rings from its own Firebase messaging service instead of the one this package declares (`"opengeni"`, the default). The plugin then declares no messaging service, so the app's service stays the only one receiving pushes, and sets the `dev.opengeni.call.APP_MESSAGING_SERVICE` meta-data flag, so agents can ring the phone with or without `expo-notifications`. Permissions, the call service and the ring screen are the same as above. See [Android rings through your own messaging service](#android-rings-through-your-own-messaging-service).
- **`iosAudioDevice: true`** (inside `call`, needs `react-native-webrtc`): WebRTC's audio on iOS runs through Opengeni's call audio device instead of WebRTC's built-in one. While a CallKit call rings, the device sends silent audio and plays nothing, so the voice session can connect before the person answers without the microphone opening (`incoming.connectsBeforeAnswer` is then true). Once CallKit activates the audio session it runs Apple's voice-processing I/O, as WebRTC's own device does. Off by default.

For meetings that keep recording with the screen locked, add `"recording": true`: it adds the `audio` background mode on iOS and the microphone foreground service on Android. An entry with only `recording` sets up nothing for calls, so a meetings-only app gets no `voip` mode, call activity or Siri intents. Add `call` as well to set up both, or pass `"call": false` to leave calls out of any entry.

Without the plugin, set the keys yourself:

```json
{
  "ios": {
    "infoPlist": {
      "UIBackgroundModes": ["audio", "voip"],
      "NSUserActivityTypes": ["INStartCallIntent"],
      "NSMicrophoneUsageDescription": "Talk to your agent on voice calls."
    }
  }
}
```

CallKit refuses call requests from an app without the `voip` background mode, so without it the call still talks but never appears as a system call (lock screen, Dynamic Island, Phone recents, headset controls).

In a monorepo where this package is linked rather than installed, add its folder to `expo.autolinking.searchPaths` in the app's `package.json`.

### Android rings through your own messaging service

An app that already has its own Firebase messaging service (for example from `@react-native-firebase/messaging` or a native SDK) keeps it and hands agents' rings to Opengeni from it. Set `"androidMessagingService": "app"` next to `"androidSystemCall": true` in `call`, then call `OpenGeniCallPush.handle` first in the service's `onMessageReceived`:

```kotlin
import dev.opengeni.call.OpenGeniCallPush

class AppMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    // A ring, or the end of a ring answered or declined elsewhere: Opengeni shows it.
    if (OpenGeniCallPush.handle(this, message.data)) return
    // ...the app's own handling of every other push
  }
}
```

`handle(context, data): Boolean` (`OpenGeniCallPush.handle(context, data)` from Java too) returns true when it consumed the message: it reported a ring as an incoming system call, or stopped a ring that was settled elsewhere. Show nothing for it then. It returns false for any other message, and for a ring this phone cannot show as a system call (Android before 8.0, or system calls not permitted); handle that as an ordinary push, which for a ring means showing the "… is calling" notification from its `title` and `message` entries. It returns quickly and is safe on the service's background thread.

Keep exactly one service for `com.google.firebase.MESSAGING_EVENT`. If the app also uses `expo-notifications`, its service is in the build too: extend `ExpoFirebaseMessagingService` and call `super.onMessageReceived` for messages `handle` did not consume, or remove the other one in the manifest. Register the phone's FCM registration token with Opengeni as for any push (`registerNativePushDevice` with `platform: "android"` and the package name as `appId`), and again when Firebase rotates it.

The ring arrives as a high-priority FCM data message (`android.priority: "HIGH"`, no `notification` block). Its collapse key is the call id and it expires when the ring does, so a phone that comes online too late never rings. Every data entry is a string; the call is the JSON in `opengeniCall`:

| `type` | Other `opengeniCall` fields | Other data entries |
| --- | --- | --- |
| `"ring"` | `callId`, `sessionId`, `workspaceId`, `subjectId`, `title` (the caller shown, or null), `reason` (why the agent calls, or null), `ringUntil` (ISO 8601 time the ring stops, or null) | `title`, `message` and `body` of the ordinary "… is calling" notification |
| `"ended"` | `callId`, `reason`: `"answeredElsewhere"`, `"declinedElsewhere"` or `"remoteEnded"` | none; there is nothing to show |

```json
{
  "opengeniCall": "{\"type\":\"ring\",\"callId\":\"…\",\"sessionId\":\"…\",\"workspaceId\":\"…\",\"subjectId\":\"…\",\"title\":\"Agent\",\"reason\":\"The deploy finished\",\"ringUntil\":\"2026-01-01T12:00:40.000Z\"}",
  "title": "Agent is calling",
  "message": "The deploy finished",
  "body": "{…}"
}
```

`createExpoCallAdapter()` reports `incoming` on such a build as on one with Opengeni's own messaging service, so `NativeAgentCallProvider` takes the rings without further setup.

### Full-screen rings on Android 14 and later

From Android 14, Play grants `USE_FULL_SCREEN_INTENT` up front only to apps whose core function is calling or alarms. In any other app an agent's ring shows only as a heads-up notification, easy to miss on a locked phone, until the person allows full-screen notifications for the app in system settings. `useFullScreenRings(callAdapter)` tracks this and re-checks whenever the app returns to the foreground, for example from that setting:

```tsx
import { useFullScreenRings } from "@opengeni/react-native";

const fullScreen = useFullScreenRings(callAdapter);

<Switch
  value={callsOn}
  onValueChange={(on) => {
    setCallsOn(on);
    // Explains why in an alert and offers to open the setting; nothing when allowed.
    if (on) fullScreen.ask();
  }}
/>;
{callsOn && !fullScreen.allowed ? (
  <Button title={fullScreen.messages.title} onPress={() => void fullScreen.openSettings()} />
) : null}
```

- `allowed` is false only on Android 14 and later while the setting is off; it is true on iOS (CallKit always rings full screen), on older Android, and in builds that cannot ring.
- `ask()` shows the explanation with "Not now" and "Open settings"; `openSettings()` opens the app's full-screen notification setting directly (or its notification settings where a phone has no such screen) and resolves false if nothing opened. `messages` holds the default, translatable text for a settings row or footer; pass `messages` to replace it.
- The same check is on the call adapter for hosts without React state: `incoming.canRingFullScreen?.()` and `incoming.openFullScreenRingSettings?.()`, both absent where rings always show full screen.
