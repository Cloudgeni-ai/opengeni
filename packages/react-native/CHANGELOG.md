# @opengeni/react-native

## 5.4.2

### Minor Changes

- 3a2f020: Chat messages now render math. Inline and display TeX written with `$…$`, `$$…$$`, `\(…\)` or `\[…\]` is typeset with KaTeX on the web and as SVG (MathJax's TeX font, no WebView) in the native timeline, instead of showing as source with its backslashes stripped. Single dollars follow Pandoc's rule, so prices such as `$5 and $10` stay text, and code spans and fenced code are never touched. The math renderer loads on the first message that contains math: KaTeX is a separate lazy chunk on the web, and the native MathJax engine is evaluated only on first use. Invalid TeX shows its source instead of breaking the message. The shared delimiter handling is exported as `@opengeni/react/markdown-math` (`prepareMathMarkdown`, `mayContainMath`).
- 0408d62: When an agent asks for a connection in chat, the phone app now shows the same connect card as the web chat instead of a dead-end "needs to be reconnected" note. OAuth opens the system sign-in browser and returns to the conversation; key-based setup uses the native secure field; the card follows the setup's saved state, and the agent continues once the connection is ready. A first connection no longer says "reconnect". The card choice, setup state and sign-in window handling now live in renderer-neutral modules that the web and native cards share (`@opengeni/react/in-chat-connect-model`). Native approvals show app actions as the readable confirmation card the web shows, a settled approval shows a check instead of a warning, and question cards render their Markdown, help text and option descriptions as on the web. React Native's `AbortController` gains the standard abort reason and `signal.throwIfAborted()` when the runtime lacks them, which the connect flow relies on.
- 6a280a7: New `@opengeni/react-native/meetings` entry, so an app can add meetings to its phone app with the same screens the Opengeni app uses. `MeetingRecorderProvider` holds one recorder above the screens (recording keeps going while the person moves around the app or locks the phone), `MeetingsList` is the meetings page with the recorder on top, and `useMeetingView` gives one meeting's transcript plus the actions for the host's own header menu. They read the client and workspace from `OpenGeniProvider`, take an `externalRef` to scope a list (and new recordings) to something in the host, and every label comes from the shared Opengeni catalog under `native.meetings.*`, so hosts translate them like the rest.
- 70623d6: Phone apps can walk people through starting a voice call with a spoken phrase of their own, such as "Hey Opengeni". iPhone (iOS 18 and later) runs a Siri request when the person says a phrase they taught it under Settings › Accessibility › Vocal Shortcuts; apps cannot create those phrases themselves. The new `WakePhraseGuide` shows the three steps, copies the Siri request that starts the app's call shortcut ("Talk to <name>" by default, so it must match one of the call plugin's phrases), and opens Settings. `wakePhraseSetupAvailable()` says whether the phone supports it. The Opengeni phone app offers it in Settings as Set up "Hey Opengeni". The guide's text uses new `native.realtime.wakePhrase.*` message keys.

### Patch Changes

- d30a243: The live transcript preview can stream to gpt-4o-transcribe and gpt-4o-mini-transcribe on OpenAI or Azure OpenAI, so a deployment that keeps audio in one region (for example Azure in the EU) can offer it. `OPENGENI_RECORDING_LIVE_TRANSCRIPTION` (`provider/model`) names the deployment's live model; with `OPENGENI_SPEECH_TO_TEXT_PINNED`, the preview goes only to the pinned provider or this model, while meetings and dictation stay on the pin. Live sessions use the new `openai.realtime` protocol: the grant carries a short-lived client secret (`token`) and a `webrtcUrl`. A browser recorder sends a copy of each track over WebRTC, muted while paused and after Stop; React Native streams PCM over a WebSocket signed in with a header. `createLiveTranscriber` takes `mediaTrack`, `RTCPeerConnection`, `fetch`, `now` and `webSocketHeaders`, and the transcriber has `setPaused`. Audio held while connecting is resampled when the session's rate differs. The Azure OpenAI voice input provider can sign in with the deployment's own Microsoft Entra identity when its endpoint or deployment is named for voice input and it has no key.
- 454ca0a: A transcript that failed because its model's provider has no key now names the model and that provider ("Scribe v2 needs ElevenLabs, which isn't connected…"), on the web and on phones, instead of saying that no transcription provider is connected. It suggests trying another model only when the deployment offers more than one, and for a provider the deployment itself pays for it points to whoever runs the deployment rather than to Organization settings. `transcriptErrorText` takes an optional third argument with the model's and provider's names, and optionally its `funding` and whether the deployment is `pinned`.
- 454ca0a: A meeting recording no longer stops when the person switches to another workspace. The recorder stays with the workspace the recording started in until it stops, then moves to the workspace shown. On the web and in the desktop app the recorder is also kept through a dropped connection or an update. After Stop, a recording made in another workspace opens in its own workspace. `MeetingRecorderProvider`'s `onOpenMeeting` now also receives the meeting's workspace ID. `useMeetingRecorder()` returns the recorder's `workspaceId` and `openMeeting`, and `createMeetingRecorderStore` takes an optional second argument that opens a meeting in its workspace. `MeetingRecorderProvider` takes an optional `scope`, such as the signed-in person's id, for a host that mounts it above sign-in: a new value ends a recording at once, and null means nobody is signed in, so nothing records and a desktop "Record" request is not kept for whoever signs in next. The console passes the signed-in person, so signing out or another person signing in ends a recording at once. `MeetingRecorderStore`'s new `workspaceId` and `openMeeting` members are optional, so stores made by hand still type-check.
- 627bcd6: Meetings started without a title show a local, readable title instead of the server's UTC stand-in. `meetingTitle` is exported from `@opengeni/react/recordings`.
- 2a29ac1: Meetings say less, more plainly. Explanations of how things work inside (versions, model words, where audio is kept, "pieces of audio") are gone; each state says the one thing that matters and what to do. While recording in the desktop app the panel just says what it records, and an unnamed meeting started on the web is named after when it starts ("Meeting, Oct 26, 12:15") instead of getting the server's "Recording 2026-10-26 11:15 UTC".

  Form dialogs, confirm dialogs and detail sheets read their default Cancel, Close, Loading and Working… text from the host's messages (`formDialog.*`), so a translated product no longer shows them in English.

- a8b429e: Meeting model prices now show only where the workspace pays them. `GET /recording-models` returns `usdPerHour` for a model on the workspace's own key, and for a deployment's model only where its use is charged in credits; otherwise it is null. The recorder's live transcript switch, on web and phone, then says nothing about cost instead of "Uses extra transcription credit", so people whose deployment covers transcription no longer see a provider's list price.
- 26c3bc6: Meetings no longer say "Uploading" while a meeting is recorded or after Stop. Audio uploads while it records, so a meeting's page opened from Take notes now shows the recording's clock with Pause and Stop, and after Stop it reads Transcribing on the page and in the list. A paused recording reads Paused in the list, and the recorder's own line after Stop reads "Saving the rest of the audio." on web and phones. A meeting still being recorded elsewhere reads In progress; only a lost connection or a refused upload is called out. Adds `meetingHereStatus` to `@opengeni/react/recordings`; the list label for a recording in progress uses the new `meetings.recordings.inProgress` key instead of `meetings.recordings.uploading`, the recorder's `meetings.recorderPanel.uploadingCountPiecesOfAudio` and `finishingTheUpload` keys become `meetings.recorderPanel.savingTheRestOfTheAudio`, and the meeting page's unused `meetings.detailPage.uploading*` and `stillUploading` keys are removed. Hosts that translate the catalog should rename their `meetings.recordings.uploading` translation to `meetings.recordings.inProgress`, add `savingTheRestOfTheAudio` and drop the removed keys.
- 8a9e320: The meetings list and meeting screens from `@opengeni/react-native/meetings` now let iOS keep their content clear of the navigation bar, tab bar and home indicator (`contentInsetAdjustmentBehavior="automatic"`), so they also work under a translucent header. `bottomInset` is now only extra space, such as Android's bottom safe-area inset.
- de51e66: `MeetingsList` takes `onRefresh`, called when the person pulls the list, comes back to the screen or returns to the app, so a host's own state shown there (such as whether recording is on) refreshes with it.
- 9e0569f: `MeetingRecorderProvider` from `@opengeni/react-native/meetings` now runs its recorder beside the screens instead of around them. A new `storeScope` or workspace starts a fresh recorder without remounting everything below it, so an app can switch account or organization without a `key` that resets its navigation. The live snapshot only re-renders the components that read it, not the whole app several times a second while recording. `workspaceId` may be `null` while the app is still finding it.
- 6c11af5: Recording on Android 13 and later asks to post notifications right after the microphone is allowed, so the ongoing "Recording audio" notification shows, and the `recording` config plugin declares the permission. The notification and status bar now show a microphone instead of the app icon, which Android draws as a blank disc.
- Updated dependencies [931325b]
- Updated dependencies [d649005]
- Updated dependencies [5aa883b]
- Updated dependencies [4488c59]
- Updated dependencies [5a48fe7]
- Updated dependencies [3ee89da]
- Updated dependencies [f6298be]
- Updated dependencies [3a2f020]
- Updated dependencies [58d272f]
- Updated dependencies [768b175]
- Updated dependencies [801743c]
- Updated dependencies [cb5f4d7]
- Updated dependencies [01188c9]
- Updated dependencies [415c32b]
- Updated dependencies [995c16f]
- Updated dependencies [53e1fe5]
- Updated dependencies [ebf148a]
- Updated dependencies [d30a243]
- Updated dependencies [659f5a4]
- Updated dependencies [5b9feb9]
- Updated dependencies [454ca0a]
- Updated dependencies [de7087a]
- Updated dependencies [454ca0a]
- Updated dependencies [a2ae2ce]
- Updated dependencies [cb15454]
- Updated dependencies [627bcd6]
- Updated dependencies [a5a9336]
- Updated dependencies [0da62e3]
- Updated dependencies [2a29ac1]
- Updated dependencies [a8b429e]
- Updated dependencies [627bcd6]
- Updated dependencies [26c3bc6]
- Updated dependencies [464f57b]
- Updated dependencies [57cfc37]
- Updated dependencies [f20b8fb]
- Updated dependencies [96502c5]
- Updated dependencies [d3d8ccf]
- Updated dependencies [0408d62]
- Updated dependencies [8be9be2]
- Updated dependencies [b18d187]
- Updated dependencies [7bb67e3]
- Updated dependencies [936d9e0]
- Updated dependencies [5f332c1]
- Updated dependencies [69a05bd]
- Updated dependencies [6a280a7]
- Updated dependencies [24b71c6]
- Updated dependencies [d8ae831]
- Updated dependencies [1320698]
- Updated dependencies [54c2f9e]
- Updated dependencies [936d9e0]
- Updated dependencies [4651b0d]
- Updated dependencies [f1579d6]
- Updated dependencies [70623d6]
  - @opengeni/contracts@5.4.0
  - @opengeni/sdk@5.4.0
  - @opengeni/react@5.4.0

## 5.3.1

### Minor Changes

- 31bca3c: Composer dictation is now a recording with `purpose: "dictation"`, recorded, uploaded and kept by the same local-first pipeline as meetings, so a closed tab, a killed phone app, a dropped connection or a failed transcription never loses what was said. A dictation has one microphone track, is always private, is transcribed and billed as voice input, sends no webhook events, never appears with meetings, and is deleted a day after it is heard. `GET …/recordings?purpose=dictation` (and `listRecordings({ purpose })`) lists the caller's own kept dictations, so the next composer offers text an earlier page left behind.

  `useVoiceInput` records through the recordings API when the client can and the deployment advertises `voiceInput.resumable`, inserts the text once (taking it deletes the dictation first, so two tabs never insert it twice), keeps anything longer than three seconds on Cancel or Escape, and hears a failed dictation again on Retry. It is also exported from `@opengeni/react/recordings`, and `useNativeDictation` in `@opengeni/react-native/recordings` brings the same dictation to phones on the native recorder. A client with only `transcribeAudio` records in memory and sends one request, as before. `ComposerTranscriptionControl` accepts `recordings` and `platform`; `createRecordingStore` and `createOwnerId` are deprecated and ignored.

  The `transcription-recordings` routes and their SDK methods are deprecated, answer with `Deprecation` and `Sunset` headers, and are kept until January 26, 2027. See https://docs.opengeni.ai/integrate/meetings#moving-from-transcription-recordings.

- 1cac78f: Record meetings on phones. `@opengeni/react-native` adds native microphone capture for iOS and Android that keeps recording in the background and writes AAC chunks to the device before they are uploaded, an on-device chunk store, and an Expo config plugin for the microphone permission and background audio. `useRecorder` from `@opengeni/react/recordings` takes a `platform`, so the same hook drives the browser and the phone recorder; the meeting list and transcript view models are shared from `@opengeni/react/recordings`.

  The SDK's `RecordingUploader` no longer leaves a recording that captured no audio stuck uploading: it removes it, on the server and on the device, and reports `discarded`. Stopping a recording while a chunk is still being uploaded can no longer be lost. The worker accepts AAC tracks and remuxes them before transcription.

  Speakers nobody named now read the same on the server and in every client: `defaultRecordingSpeakerName` from `@opengeni/contracts` gives "Speaker 2" for a diarized `speaker_1` and "Microphone" or "Shared audio" for a whole-track label, and the API's speaker `name` uses it. A speaker counts as named only when it has an assignment (`source` is set). Transcript versions report BCP 47 language tags, so ElevenLabs' `eng` is now `en`.

  An upload refused with 401, 408, 425 or 429 is retried with backoff instead of failing, since a sign-in that loads late or is refreshed, a timeout or rate limiting doesn't make the recording bad. `useRecorder` sends its uploads through the latest client it was given, so a recorder created before the app's sign-in token loaded no longer uploads without it, and only the current recording updates what the hook shows.

  `RecordingUploadStatus.created` says when the server has a new recording, so a list can refresh then and show it while it is still being recorded. `languageName` names ISO 639-2 codes such as `eng` on engines that don't canonicalize them, like Hermes.

- 9efd19f: The phone app shows and manages a session's full access like the web header does. `SessionHeaderTitle` takes `fullAccess` and then shows a small shield and "Full access" on its status line. The new `@opengeni/react/session-admin-access-model` entry point shares the offered time limits (`ADMIN_ACCESS_DURATIONS`, `adminAccessDurationHours`), `endsText`, `adminAccessGrantedByText` and the grant description between web and native.
- 021130f: Phones show the live transcript too. With `liveTranscript: true`, the native recorder streams the microphone to the workspace's live speech model and fills `snapshot.live`, as the browser recorder does. The native capture module sends a 16 kHz copy of the audio (`onPcm`) only while it is asked for (`setLivePcm`); paused audio is not sent, and an app build without the new module records as before with no live text. The live text helpers `groupLiveTurns`, `tidyLiveText` and `tidyPartialText` are now in `@opengeni/react/recordings`, so a phone and a web page join live text the same way.

### Patch Changes

- 58cb43d: Build the `./recordings` entry so the published package ships `dist/recordings/index.js`.
- 314522c: A meeting can be renamed while it records. `Recorder.rename(title)` (and `rename` from `useRecorder`) stores the title with the recording on the device: before the server has the recording it goes out with its creation, after that with the next upload pass, so a dropped connection only delays it; once the recording is finalized it goes straight to the server. The recorder snapshot now has the `title`. `RecordingTransport` may include `updateRecording`, which renaming needs once the server has the recording. The web recorder shows the meeting's name while recording, with Rename.
- Updated dependencies [c8ddf55]
- Updated dependencies [de7e142]
- Updated dependencies [1988e97]
- Updated dependencies [0676499]
- Updated dependencies [e7f5d38]
- Updated dependencies [c5974ea]
- Updated dependencies [15b4701]
- Updated dependencies [b4acabd]
- Updated dependencies [adeb323]
- Updated dependencies [7ae955f]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
- Updated dependencies [5a256f4]
- Updated dependencies [3046e82]
- Updated dependencies [7e88548]
- Updated dependencies [8e20038]
- Updated dependencies [eb30cb4]
- Updated dependencies [ce72530]
- Updated dependencies [4c6bf32]
- Updated dependencies [f3d19a2]
- Updated dependencies [45cddc7]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [9f6cab2]
- Updated dependencies [d806f0f]
- Updated dependencies [6f6c356]
- Updated dependencies [d502ba3]
- Updated dependencies [8da1f14]
- Updated dependencies [8b34e6d]
- Updated dependencies [cccd692]
- Updated dependencies [3fa5c6e]
- Updated dependencies [d6c7c4a]
- Updated dependencies [dca33ef]
- Updated dependencies [392db50]
- Updated dependencies [3b9f0e5]
- Updated dependencies [dcbe25d]
- Updated dependencies [31bca3c]
- Updated dependencies [1d5bc4e]
- Updated dependencies [6acfbd3]
- Updated dependencies [21e7ecf]
- Updated dependencies [fb90446]
- Updated dependencies [0826dfd]
- Updated dependencies [627b2f1]
- Updated dependencies [6168cfe]
- Updated dependencies [bd57ea7]
- Updated dependencies [c307566]
- Updated dependencies [a97c71b]
- Updated dependencies [90e52dc]
- Updated dependencies [8bd2c99]
- Updated dependencies [406d1b9]
- Updated dependencies [2806e31]
- Updated dependencies [2c34440]
- Updated dependencies [c992791]
- Updated dependencies [87d1b8a]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [78ff3e6]
- Updated dependencies [9efd19f]
- Updated dependencies [1477b70]
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [021130f]
- Updated dependencies [68b195d]
- Updated dependencies [e0f94c2]
- Updated dependencies [9be821d]
- Updated dependencies [fcb58f9]
- Updated dependencies [ca88f26]
- Updated dependencies [f9f0607]
- Updated dependencies [75348a5]
- Updated dependencies [cc319f3]
- Updated dependencies [314522c]
- Updated dependencies [3b1d8c1]
- Updated dependencies [ee4df07]
- Updated dependencies [7d419e2]
- Updated dependencies [e5446f1]
- Updated dependencies [83682c3]
- Updated dependencies [a9809ee]
- Updated dependencies [acac580]
- Updated dependencies [f3d19a2]
- Updated dependencies [198d6f5]
- Updated dependencies [31c3308]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [b7a14bd]
- Updated dependencies [119f33d]
- Updated dependencies [c194abb]
- Updated dependencies [1b99a18]
- Updated dependencies [0383280]
- Updated dependencies [1534f12]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0
  - @opengeni/react@5.3.0
  - @opengeni/sdk@5.3.0

## 5.2.1

### Patch Changes

- Updated dependencies [fb72b9d]
- Updated dependencies [b3a641c]
- Updated dependencies [2d6484c]
- Updated dependencies [c4d18a1]
  - @opengeni/react@5.2.0
  - @opengeni/contracts@5.2.0
  - @opengeni/sdk@5.2.0

## 5.1.2

### Patch Changes

- Updated dependencies [5d377a7]
- Updated dependencies [9c72069]
  - @opengeni/sdk@5.1.0
  - @opengeni/react@5.1.0
  - @opengeni/contracts@5.1.0

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
- Updated dependencies [1320d6c]
- Updated dependencies [929ca26]
- Updated dependencies [217ed52]
- Updated dependencies [ce7f5f3]
- Updated dependencies [f7dfe7a]
  - @opengeni/sdk@5.0.0
  - @opengeni/react@5.0.0
  - @opengeni/contracts@5.0.0

## 4.8.0

### Patch Changes

- fd953dc: A sub-session question that an agent (such as the parent) answered or skipped is now shown as agent work instead of conversation: one quiet "Asked Target branch → main" row inside the turn's "Worked for" details, which opens to the question, who answered, and the answer. Nothing appears on the person's side any more. Questions a person answered, system skips (a scheduled run's unanswered question), and expired, cancelled or still pending questions look as before. `@opengeni/react/timeline-model` exports `isAgentWorkHumanInput` and `agentWorkHumanInputSummary` so custom renderers make the same decision. React Native: `NativeTimelineMessages.humanInputOutcome` and `OpenGeniNativeLabels.humanInputOutcome` gain an optional `agentSkipped` (defaults to `skipped`), and host overrides of `agentAnswered` still apply to the new row. `OpenGeniNativeSessionView`, which has no turn work details, shows the question as a compact step.
- Updated dependencies [fd953dc]
- Updated dependencies [3089aaf]
- Updated dependencies [bcce117]
- Updated dependencies [e2a641c]
- Updated dependencies [85fb89e]
  - @opengeni/react@4.8.0
  - @opengeni/sdk@4.8.0
  - @opengeni/contracts@4.8.0

## 4.7.2

### Patch Changes

- 8301382: A sub-session's question can now be answered by the person or by the parent agent, and the first answer wins. The parent's `child_requires_action` notice now carries each question's id, kind, prompt and option ids and labels (never secret specs), so the parent can answer with `session_human_input_respond` without reading the sub-session's history. The notice now also wakes an idle parent that has no goal. An agent whose answer arrives after someone else's gets `outcome: "unchanged"` with `alreadyAnswered: true`, who answered, and a warning not to answer again; before, it got a success-looking `replayed` result. The `user.humanInputResponse` event records whether a person, API key, agent or the system answered. The agent instructions and the `request_human_input` and `session_human_input_respond` descriptions now say that a parent answers when it can from its task context, leaves questions only a person can answer (decisions, preferences, credentials, approvals) to the person, and never answers on the person's behalf. The conversation now says "Agent answered" instead of "You answered" when an agent gave the answer.
- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
- Updated dependencies [e423d8f]
- Updated dependencies [b3fc68b]
- Updated dependencies [ee5020c]
  - @opengeni/contracts@4.7.2
  - @opengeni/sdk@4.7.2
  - @opengeni/react@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/contracts@4.7.1
- @opengeni/react@4.7.1
- @opengeni/sdk@4.7.1

## 4.7.0

### Patch Changes

- Updated dependencies [f6d388d]
- Updated dependencies [28a7a33]
- Updated dependencies [31095f1]
- Updated dependencies [c09c85e]
- Updated dependencies [0b378e8]
- Updated dependencies [a0a7916]
  - @opengeni/react@4.7.0
  - @opengeni/contracts@4.7.0
  - @opengeni/sdk@4.7.0

## 4.6.1

### Minor Changes

- d0eb91c: A session's sub-agents now come back newest first at each level, and the 200-agent cap keeps direct agents and newer ones before deeper or older ones (it used to keep an arbitrary subset ordered by id). `sessionAgentAttention` and `formatWaitingSince` in `@opengeni/react/session-agents-model` give the word a manager must act on (Needs you · 10h, Failed, Stuck, Paused) for web and native. The phone's agents sheet shows that word in place of the time, and folds each agent's own agents behind a count.

### Patch Changes

- Updated dependencies [e7ca55f]
- Updated dependencies [d0eb91c]
  - @opengeni/sdk@4.6.0
  - @opengeni/react@4.6.0
  - @opengeni/contracts@4.6.0

## 4.5.0

### Minor Changes

- 1d65f48: The mobile app can search chats across all of a person's workspaces, like ⌘K on the web. A search button on the home screen opens the chat search, which matches chat titles in the current workspace first and in the person's other workspaces after, labelling each chat from another workspace with its workspace's name. Matching workspaces appear too, so a search can also switch workspace. Opening a chat from another workspace switches to that workspace. `SessionRow` accepts an optional `workspaceName`, and `@opengeni/react` exports the chat-title ranking helpers `rankLabel`, `foldForSearch` and `LOOSE_MATCH_BELOW`.

### Patch Changes

- 7e5e08f: Every first-party tool step in the timeline now draws an icon that matches its words (a globe for the browser, a monitor for the screen, a spreadsheet for Excel, an hourglass for waiting, and so on) instead of the generic wrench. The mapping lives in one shared table keyed by tool step, so the web app, React Native and embedded chats all get the same icons; a new step without an icon fails to compile. Connector and custom tools keep their family icon or the wrench.
- c64be29: A link the host draws as a block card now spans the message width when it is alone in its paragraph, instead of sizing to its content. A list item whose only content is such a card drops its bullet or number and indent, so it lines up with the same card on its own line.
- Updated dependencies [f838cb7]
- Updated dependencies [6f9b6f5]
- Updated dependencies [7e5e08f]
- Updated dependencies [1d65f48]
- Updated dependencies [debd64e]
- Updated dependencies [0910456]
- Updated dependencies [3e4426e]
- Updated dependencies [68c3907]
- Updated dependencies [e38f20d]
- Updated dependencies [e22eeca]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
- Updated dependencies [0b3b079]
- Updated dependencies [d8179be]
  - @opengeni/contracts@4.5.0
  - @opengeni/sdk@4.5.0
  - @opengeni/react@4.5.0

## 4.4.1

### Minor Changes

- e3c07bc: Embedded chats can now explain why a message didn't start. When a shared chat still runs on someone else's personal computer and another participant's message is held, `SessionStartNotice` from `@opengeni/react/session-ui` says why in the reader's language, lists the machines they're allowed to use, and offers one recheck once the chat has moved. The saved message is kept and is never sent twice, and access rules are unchanged. `useSessionStart` and the matching model helpers are available from `@opengeni/react/session` for custom layouts, and all text comes from the new `sessionAdmission.*` message keys. The React Native session screen shows the same explanation and machine choices. The hosted app now uses these same components.
- 0043cc8: Native chat Markdown can now draw the host's own links, like `renderLink` on the web. Pass `renderLink` to `createWebMarkdownRenderer` to draw links with your own scheme (`myapp:order/42`), in-app paths or web URLs yourself; return `undefined` to keep the default link. A link that is the only content of its paragraph or list item arrives with `standalone: true` and may be drawn as a block, such as a card. Inline links sit inside text, so draw them with `Text`. Opengeni object links (`artifact:`, `sandbox:`) still go to `onOpenGeniLink`.

### Patch Changes

- 996e6b4: On the React Native session screen, Try again on a message that couldn't start shows as busy while it rechecks again, and a second tap before the recheck finishes no longer sends a second request.
- Updated dependencies [dd61c8d]
- Updated dependencies [efd4df0]
- Updated dependencies [4ff99bd]
- Updated dependencies [23dfcb2]
- Updated dependencies [b800b7f]
- Updated dependencies [e697879]
- Updated dependencies [a506901]
- Updated dependencies [dfa5df0]
- Updated dependencies [565253c]
- Updated dependencies [11e56da]
- Updated dependencies [2a2acb2]
- Updated dependencies [343c1aa]
- Updated dependencies [524ddde]
- Updated dependencies [b58a428]
- Updated dependencies [e3c07bc]
- Updated dependencies [182eff6]
- Updated dependencies [926e0b8]
- Updated dependencies [73132c4]
- Updated dependencies [85c0948]
- Updated dependencies [67ce6ff]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [b81d318]
- Updated dependencies [7157f58]
- Updated dependencies [d295544]
- Updated dependencies [614c744]
- Updated dependencies [201c380]
- Updated dependencies [81a516c]
- Updated dependencies [60e031c]
- Updated dependencies [486abe4]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [67882a3]
- Updated dependencies [84c8b32]
- Updated dependencies [b7943f4]
- Updated dependencies [886dc39]
- Updated dependencies [f7f7987]
- Updated dependencies [84b1a18]
  - @opengeni/react@4.4.0
  - @opengeni/contracts@4.4.0
  - @opengeni/sdk@4.4.0

## 4.3.1

### Minor Changes

- 83a467d: Opening a turn's steps now reads large tool outputs as bounded previews instead of whole payloads, so a long turn's steps load in a fraction of the bytes. A row reads its full output once, when it is expanded or when its renderer needs the exact result (screenshots, images, receipts, search results, and custom renderers). Until then its body says the full output is loading, and if that read fails it says the body is a preview and offers Retry. Presented results such as images, published files and Skill or Knowledge writes are still read in full. `listEventPage` and `listEvents` accept `toolOutputs: "preview"`; servers that predate it return exact outputs. `ToolCallItem.outputPreview` and the `ToolOutputPreview` type are new and additive.

  `useSessionEvents().events` now carries those previews for opened turns until a row's exact output is read. A previewed `agent.toolCall.output` payload is marked with `outputPreview` (`truncated: true`, `shape`, `originalBytes`, `previewBytes`); with `shape: "text"` its `output` is the head and tail of the output's text rather than the original value. Code that reads tool outputs from `events` should treat a payload with `outputPreview` as partial, and read the exact event with `listEventPage` when it needs it.

- 67262de: Adds the Ultrafast speed for GPT-6 Astra and GPT-6.1 Sol. When a model offers it, the model picker replaces the Fast toggle with a Speed choice (Standard, Fast, Ultrafast) and shows what the faster speeds cost: 8× usage on a ChatGPT/Codex plan, or the rate multiple on metered routes. A Codex account offers Ultrafast only when its own model list advertises the tier, so the picker shows it only when some account serving the workspace can run it, and an Ultrafast turn is placed only on such an account. Ultrafast requests use `service_tier: "ultrafast"`, and a response served at a lower tier is not counted as Ultrafast. Turns accepted before a model declared Ultrafast keep running unchanged.

### Patch Changes

- Updated dependencies [49f2177]
- Updated dependencies [579239a]
- Updated dependencies [bb438b0]
- Updated dependencies [0e135b2]
- Updated dependencies [03947ed]
- Updated dependencies [6dd3785]
- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
- Updated dependencies [bf39d5e]
- Updated dependencies [cc0792a]
- Updated dependencies [540d75b]
- Updated dependencies [20b0aad]
- Updated dependencies [fda625e]
- Updated dependencies [2963eca]
- Updated dependencies [374dd81]
- Updated dependencies [91329fc]
- Updated dependencies [46a2ef3]
- Updated dependencies [579239a]
- Updated dependencies [ffe09c2]
- Updated dependencies [ee83178]
- Updated dependencies [1b57d74]
- Updated dependencies [277c99c]
- Updated dependencies [b20c9b2]
- Updated dependencies [70f0522]
- Updated dependencies [c236847]
- Updated dependencies [23fed2a]
- Updated dependencies [eeab39f]
- Updated dependencies [e4915c1]
- Updated dependencies [7ed4d2b]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [427f2a5]
- Updated dependencies [6b08cbe]
- Updated dependencies [b45d380]
- Updated dependencies [724b529]
- Updated dependencies [2058cd3]
- Updated dependencies [c6a3493]
- Updated dependencies [3915617]
- Updated dependencies [908c0d3]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [a1265ca]
- Updated dependencies [f2ec8b4]
- Updated dependencies [fe99ea2]
- Updated dependencies [b95784c]
- Updated dependencies [5f5fe8d]
- Updated dependencies [83a467d]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/sdk@4.3.0
  - @opengeni/react@4.3.0
  - @opengeni/contracts@4.3.0

## 4.2.0

### Patch Changes

- 8c38fe4: An embedded conversation marks itself read while the person watches it.

  - `@opengeni/react`: `SessionConversation` and `SessionConversationView` acknowledge each delivered reply, question or failure for the signed-in person while the timeline is on screen, the page is visible and the window focused (once per reply, never per streamed token, with `acknowledgedThroughSequence` so a late request never hides a newer reply). Unread state, and notifications a server derives from it, then skip replies the person already saw. A hidden timeline, background tab or unfocused window acknowledges nothing; `readAcknowledgement={false}` turns it off. `useSessionReadAcknowledgement` (from `@opengeni/react/session`) does the same for custom layouts. `createEmbeddedSessionClient` passes an optional `updateSessionAttention` through.
  - `@opengeni/react-native`: the native session uses the same acknowledgement implementation, which now retries a transient failure once after a short delay and stops after a permanent rejection.
  - `@opengeni/sdk`: `createSessionProxyHandler` forwards `PUT …/sessions/{sid}/attention` with only `{ unread: false, acknowledgedThroughSequence? }`.

- Updated dependencies [641e179]
- Updated dependencies [8c38fe4]
- Updated dependencies [5252d01]
- Updated dependencies [e018445]
- Updated dependencies [a868e17]
- Updated dependencies [5715a3e]
- Updated dependencies [64e6d6b]
- Updated dependencies [47eeb80]
- Updated dependencies [f6cb82d]
- Updated dependencies [44dc72a]
  - @opengeni/contracts@4.2.0
  - @opengeni/sdk@4.2.0
  - @opengeni/react@4.2.0

## 4.1.3

### Patch Changes

- Updated dependencies [404e017]
  - @opengeni/sdk@4.1.2
  - @opengeni/react@4.1.2
  - @opengeni/contracts@4.1.2

## 4.1.1

### Minor Changes

- 843bd39: Products that embed the chat can give people one Send and nothing to learn. With `busySend: "steer"` (web `composerOptions`, native `useOpenGeniNativeSession`), a message sent while the agent works is read as soon as it can, and the stock screens show no Queue choice beside Send and no Queue or Steer words: paused or lined-up messages show as waiting messages, without Steer actions. `offerQueue: true` brings the Queue choice back. `SingleSendWording` applies the same wording around your own composition of the parts.

### Patch Changes

- 395e2ff: Shared chat fixes for embedding products:

  - Counted labels no longer crash on Hermes (React Native), which has no `Intl.PluralRules`. Without it, 1 uses the `_one` form and every other count `_other`, so no polyfill is needed.
  - The voice button no longer names the voice model: it reads "Start voice", "Try voice again" and "Talk live with the agent." The React Native call screen no longer shows the model as its subtitle. Hosts can name the action after their assistant through `messages`, for example `"realtime.realtimeControl.startVoice": "Talk to Ava"`. The keys `realtime.realtimeControl.startVoiceWithLabel`, `tryVoiceAgainWithLabel` and `talkLiveWithModellabel` are replaced by `startVoice`, `tryVoiceAgain` and `talkLiveWithTheAgent`.
  - A turn that stops because automatic capacity recovery ran out now shows a translatable explanation (`lib.format.capacityRecoveryExhausted`) instead of the server's English text. The stored event is unchanged.

- 9be9a82: Steer reaches the agent within seconds and no longer kills work in progress. A model request still generating when a Steer arrives is cut short: assistant messages the provider had completed stay in history, unfinished text and unstarted tool calls are dropped, and the next request carries the Steer on the unchanged history. Short tool calls finish; long `exec_command`/`write_stdin`, `command_wait`/`command_read` and `session_wait` waits return early with their handle while the work keeps running (`session_wait` reports kind `steer`). The turn then hands over (`turn.superseded` with reason `steer`, `atModelStep: true` and, for a cut-off answer, `cutOffText`) and the Steer runs next. Several Steers are read together, in the order they were sent. Agent Steer (`session_steer`) behaves the same way. Queue (an ordinary Send) is unchanged and still runs after the whole turn. Custom model transports can honour preemption with the exported `isModelPreempted` and `preemptedResponseDone`.

  The web and React Native session screens show a Steer only as the person's message: no status row, chip or "Send now". API callers can still stop the running attempt with `interrupt: true` on `steerQueueItem` on the turn that `steerMessage` returned. A new workspace setting `busySend` (`queue` by default, or `steer`) and a matching `busySend` option on `useComposer`, `SessionConversation` composer options and `useOpenGeniNativeSession` let a product make a normal Send act as Steer while the agent is busy; Cmd/Ctrl+Enter then does the other one.

- Updated dependencies [1e16831]
- Updated dependencies [afff3f9]
- Updated dependencies [04019de]
- Updated dependencies [34081e9]
- Updated dependencies [395e2ff]
- Updated dependencies [57e3a3e]
- Updated dependencies [843bd39]
- Updated dependencies [9be9a82]
  - @opengeni/react@4.1.0
  - @opengeni/contracts@4.1.0
  - @opengeni/sdk@4.1.0

## 4.0.4

### Major Changes

- 911c0b1: Apps can now show the components in their own words and languages. Every label, notice and user-facing error in `@opengeni/react` and `@opengeni/react-native` comes from one typed message catalog: pass `locale` and `messages` to `OpenGeniProvider` (or `OpenGeniMessagesProvider` from the new DOM-free `@opengeni/react/messages` entry), with plural forms chosen per language and English as the fallback. `englishMessages` is the full default catalog for translation tooling, and `OpenGeniMessageCatalog` types a complete translation.

  Breaking: default label objects that used to be constants are now functions of the translator (for example `defaultChatComposerMessages(t)`, `SESSION_GROUP_LABELS(t)`, `DEFAULT_SESSION_USAGE_LIMIT_LABELS(t)`, `defaultNativeTimelineMessages(t)`, `DEFAULT_OPENGENI_NATIVE_LABELS(t)`), and exported helpers that produce text take the translator first (for example `buildTimeline(t, events)`, `machineDisplayName(t, machine)`, `orgLabel(t, accountId, grants)`). Get it with `useOpenGeniText()` in components, or `createOpenGeniText()` elsewhere.

### Patch Changes

- 5b10fc9: Opening a conversation reads each resource once, and reopening a recently viewed one draws at once.

  - Session, queue, lineage, goal and human-input reads now report the session sequence they reflect (`X-OpenGeni-Session-Sequence`), so the shared event feed's opening burst no longer re-reads what the first read already covers. Opening one conversation drops from 11 requests (16 inside `OpenGeniProvider`) to 7 (8 with the provider's contract check). Older servers that do not send the header keep the previous refresh behaviour.
  - `OpenGeniProvider` no longer runs its reconnect repair on the first open of a conversation; reconnects still repair every view.
  - When the host retains reads (`OpenGeniProvider retainReadsAcrossMounts` or the new `useRetainedReads(client)`), reopening a conversation draws its last timeline, details, queue, goal, lineage and open questions from memory on the first render and refreshes behind it, with no spinner. Retained conversations are kept in memory only, per client object, within the event-browser byte budget; the composer draft is always read fresh.
  - Workspace-scoped client config reads join one request per client and workspace (`readClientConfig`).

- Updated dependencies [e7113e3]
- Updated dependencies [2f6b8bd]
- Updated dependencies [9482fe0]
- Updated dependencies [2a81601]
- Updated dependencies [2a93842]
- Updated dependencies [911c0b1]
- Updated dependencies [71dfe30]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [5581036]
- Updated dependencies [79ec9fd]
- Updated dependencies [5927aae]
- Updated dependencies [6ab7b55]
- Updated dependencies [3e061d6]
- Updated dependencies [a22ed79]
- Updated dependencies [5b10fc9]
- Updated dependencies [b99865a]
- Updated dependencies [e2e75c0]
- Updated dependencies [24b346d]
- Updated dependencies [a5a5500]
  - @opengeni/contracts@4.0.0
  - @opengeni/sdk@4.0.0
  - @opengeni/react@4.0.0

## 3.4.0

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
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
