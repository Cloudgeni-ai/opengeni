# @opengeni/react

## 5.4.2

### Minor Changes

- 3a2f020: Chat messages now render math. Inline and display TeX written with `$…$`, `$$…$$`, `\(…\)` or `\[…\]` is typeset with KaTeX on the web and as SVG (MathJax's TeX font, no WebView) in the native timeline, instead of showing as source with its backslashes stripped. Single dollars follow Pandoc's rule, so prices such as `$5 and $10` stay text, and code spans and fenced code are never touched. The math renderer loads on the first message that contains math: KaTeX is a separate lazy chunk on the web, and the native MathJax engine is evaluated only on first use. Invalid TeX shows its source instead of breaking the message. The shared delimiter handling is exported as `@opengeni/react/markdown-math` (`prepareMathMarkdown`, `mayContainMath`).
- 01188c9: Automations can listen to any app's webhooks. A new `custom` webhook adapter reads deliveries as the source's `format` describes: how they are signed (`standard_webhooks`, `hmac_sha256` of the body in a header, `timestamped_hmac_sha256` as Stripe and Tailscale send, or a shared `token` header), whether one delivery holds a list of events, and where each event's type, id, time, summary, subject, link and actor are (JSON paths or headers). The whole event is the event's data, so trigger conditions can filter on any field. The secret is the one the app shows or the one a person set there; the source waits, blocked, until it is pasted. `WEBHOOK_FORMAT_PRESETS` ships Tailscale's format: "Add a source" offers Tailscale by name, and its event-type catalog lists Tailscale's documented types.
- 659f5a4: Managed accounts can sign in with a passkey. Anyone signed in adds passkeys under their sign-in methods and can then sign in with one instead of a password. With `OPENGENI_MANAGED_AUTH_PASSKEY_SIGNUP_ENABLED=true`, a new person can also create an account with only a name and a passkey, with no email address or password, while new sign-ups are open and no email allowlist is set. Passkeys are offered on trusted HTTPS or `localhost` origins in the legacy session-set mode. Rolling migration 0998 adds the passkey store but withholds it from the runtime role, so passkeys stay off until a later release grants it.
- 5b9feb9: A meeting recorded with computer or tab audio now names its microphone after the person recording. Each new transcript version gives the microphone speaker the owner's person in the speaker directory, added for them if they have none, as "It's me" does, with `source: "track"` and no confidence, so it doesn't read as a voice suggestion. A name someone gave that speaker carries over through every later version instead (before, one that had already carried over once could be replaced), and a microphone alone stays diarized as Speaker 1, 2…. The naming enrolls nobody's voice: it gives no agreement, and an unconfirmed `track` speaker never teaches a voiceprint. Starting such a recording adds the owner to the directory, so the live preview shows the microphone under the owner's name to everyone watching (the person recording sees their own) and the computer or tab audio as "Others". New exports: `recordingMicrophoneIsOwner` (contracts), `ownerLiveLaneName` (react), `workspaceMemberDisplayName` and the `TrackSpeaker` type (db); `MeetingsListPage` and `RecorderPanel` take an optional `viewerName`, and `createRecording` an optional `ownerName`.
- 454ca0a: A transcript that failed because its model's provider has no key now names the model and that provider ("Scribe v2 needs ElevenLabs, which isn't connected…"), on the web and on phones, instead of saying that no transcription provider is connected. It suggests trying another model only when the deployment offers more than one, and for a provider the deployment itself pays for it points to whoever runs the deployment rather than to Organization settings. `transcriptErrorText` takes an optional third argument with the model's and provider's names, and optionally its `funding` and whether the deployment is `pinned`.
- de7087a: Agents can write a meeting's notes. The new `meeting_notes_save` tool replaces a meeting's written-up notes (Markdown) as the person the session works for, so it reaches exactly the meetings they can see. It needs `sessions:create` and the revision `meeting_read` gave, so edits made in the meantime are not overwritten. `meeting_read` now also returns the meeting's notepad and its notes with their revision. In the timeline the tool shows as "Saving meeting notes", and it is part of the Meetings capability group.
- 454ca0a: A meeting recording no longer stops when the person switches to another workspace. The recorder stays with the workspace the recording started in until it stops, then moves to the workspace shown. On the web and in the desktop app the recorder is also kept through a dropped connection or an update. After Stop, a recording made in another workspace opens in its own workspace. `MeetingRecorderProvider`'s `onOpenMeeting` now also receives the meeting's workspace ID. `useMeetingRecorder()` returns the recorder's `workspaceId` and `openMeeting`, and `createMeetingRecorderStore` takes an optional second argument that opens a meeting in its workspace. `MeetingRecorderProvider` takes an optional `scope`, such as the signed-in person's id, for a host that mounts it above sign-in: a new value ends a recording at once, and null means nobody is signed in, so nothing records and a desktop "Record" request is not kept for whoever signs in next. The console passes the signed-in person, so signing out or another person signing in ends a recording at once. `MeetingRecorderStore`'s new `workspaceId` and `openMeeting` members are optional, so stores made by hand still type-check.
- 4e83a4d: The meeting page reads like notes. `MeetingDetailPage` has Summary · Transcript · Notepad tabs under the title, opening on Summary when the meeting has written notes and on Transcript otherwise; while the meeting is recorded on this device it keeps the single page with the recording bar, notepad and live preview. An unsaved edit of the Summary survives switching tabs, and changing `recordingId` starts the page fresh for that meeting. Transcript turns show the speaker's name once in their colour above a soft bubble, and a pencil on hover or focus opens "Correct the words" directly beside the ⋯ menu. The Summary shows `[Name](speaker:<label>)` and `[Name](person:<id>)` mentions as chips with the speaker's or person's current name (unknown ones read as plain text), and Copy copies the Markdown with names in place of mentions (code and images stay as written); the format is documented under Notes in `docs/recordings.md`. The standalone `MeetingNotes` shows mentions as their plain link text. A new optional `onAsk(recordingId, question)` adds "Ask about this meeting" under Summary and Transcript; resolve false to keep the question when the host couldn't take it. New English keys: `meetings.ask.couldNotAsk`, `meetings.ask.placeholder`, `meetings.ask.send`, `meetings.detailPage.show`, `meetings.detailPage.summary`, `meetings.notes.copied`, `meetings.notes.copy`, `meetings.notes.couldNotCopy` and `meetings.transcript.correctTheWordsOfNameAt`. The `@opengeni/react/testing/meetings` ready meeting's notes now use mentions.
- 96502c5: A message someone else sends to a chat that runs on another member's personal machine no longer blocks the chat. It waits for the machine's owner instead: it never starts or interrupts the owner's turns, the owner's next message brings it to the agent as context, and it runs on its own once the chat moves to a machine the sender may use. Steering a waiting message, and an agent steering such a chat on behalf of somebody else, are refused with a clear reason. Send results report `waitsForMachineOwner`, and the chat's machine explanation lists whose messages wait (`waitingMessages`). This takes effect once a later release grants the runtime the new machine-owner lookup; until then chats behave as before.
- 0408d62: When an agent asks for a connection in chat, the phone app now shows the same connect card as the web chat instead of a dead-end "needs to be reconnected" note. OAuth opens the system sign-in browser and returns to the conversation; key-based setup uses the native secure field; the card follows the setup's saved state, and the agent continues once the connection is ready. A first connection no longer says "reconnect". The card choice, setup state and sign-in window handling now live in renderer-neutral modules that the web and native cards share (`@opengeni/react/in-chat-connect-model`). Native approvals show app actions as the readable confirmation card the web shows, a settled approval shows a check instead of a warning, and question cards render their Markdown, help text and option descriptions as on the web. React Native's `AbortController` gains the standard abort reason and `signal.throwIfAborted()` when the runtime lacks them, which the connect flow relies on.
- b18d187: Failures no longer show people text that was written for operators. When a turn fails with an unclassified error, or with one of the few codes whose recorded text is an operator diagnostic (`pre_claim_failure`, `interrupted_turn_retired`, `worker_death_redispatch_exhausted`, `sandbox_command_observation_unavailable`, `sandbox_command_start_outcome_unknown`, `sandbox_materialization_verification_failed`, `invalid_sse_terminal`), the timeline names the outcome instead: the startup step the turn failed at, in that step's own words ("Sandbox didn't start"), or "The turn stopped unexpectedly". The recorded text stays reachable: as the turn chip's hover title, behind Details on a failed turn's notice, and behind Details on the failed startup step, which now expands to show its recorded error (except under `toolDetails="plain"`). The failed-session banner uses the same rule and says "The sandbox didn't start." when that is what happened. Copy the worker writes for people (coded provider, subscription, MCP and other failures) is unchanged, and stored events, including the text the agent reads, are untouched.

  Because the projection now presents the failure once, `TurnEndItem.failureText` and the timeline groups' `failureText` hold the people-facing summary, with the replaced text in the new optional `failureDetail`; `TurnSummary` takes a matching `failureDetail` prop. React Native and other renderers of `failureText` get the plain summary without changes. `StartupPhaseItem` gains an optional `detail`, and `presentFailure` returns a `diagnostic` flag.

- 6a280a7: New `@opengeni/react-native/meetings` entry, so an app can add meetings to its phone app with the same screens the Opengeni app uses. `MeetingRecorderProvider` holds one recorder above the screens (recording keeps going while the person moves around the app or locks the phone), `MeetingsList` is the meetings page with the recorder on top, and `useMeetingView` gives one meeting's transcript plus the actions for the host's own header menu. They read the client and workspace from `OpenGeniProvider`, take an `externalRef` to scope a list (and new recordings) to something in the host, and every label comes from the shared Opengeni catalog under `native.meetings.*`, so hosts translate them like the rest.
- 1320698: Agents can link another chat as `[title](session:<sessionId>)`. `parseOpenGeniLink` returns a `session` target and `openGeniConsolePath` maps it to the chat's console route. A link resolver may now return `{ href, open }`: a plain click runs `open` in place while modified clicks keep the browser's handling of `href`. The console opens chat references in place, and a reference no host resolves shows just its title.
- 936d9e0: Add optional Turnstile signup verification, reversible promotional-credit holds, and signature-backed repeated free-credit claim detection. Keep purchased credit and incurred usage settlement intact, with tenant-safe balance projections and owner-only audited review controls. All enforcement defaults off and requires explicit deployment configuration after every funding reader is upgraded.
- f1579d6: The Site view header says whether a Site is on the web, and publishes it from there. A published Site shows "Published", whose menu names the address with Open, Copy link and, for people who can publish, Publishing settings; an unpublished Site shows Publish to those people. Publish and Publishing settings open the Site's own publish form (the same form, permissions and publication as its Settings tab) in place of the Site, with the chat still beside it. The Site view no longer shows the frame's "Live" label, so "Live" never reads as "on the web"; Updating and Reconnecting still show. In the app components, `SitePublicLink` is now `SitePublicationControl` (it takes `onOpenPublishing` instead of linking to Settings), `useSitePublicationLink` returns `{ load, update }`, and `SitePublishPage` accepts `onSubmitted` and titles a published Site's form "Web address" in every layout.

### Patch Changes

- d649005: An open chat's artifact list no longer reads the catalog once per sub-session. `GET /v1/workspaces/:workspaceId/artifact-catalog` takes `includeSubSessions=true` with `sourceSessionId`. The server then lists that chat and the sub-sessions its lineage lists (depth 5, 200 at most) in one keyset-paged query. It authorizes those sessions in one batch and skips any the caller may not read, and each item keeps its own `sourceSessionId`. The session dock now makes two paged reads per refresh (active, then archived) however many sub-agents the chat started, with no lineage read or per-sub-session cache. It keeps at most one refresh in flight and runs one more afterwards if new tool output arrived meanwhile. Before, a chat with about 50 running sub-agents re-read up to about 100 catalog pages on every turn end and overlapped those reads on a busy chat. Rolling migration 0991 lets the published-file listing routine accept a bounded `sourceSessionIds` list. The previous release's single `sourceSessionId` keeps its meaning.
- 768b175: `@opengeni/react/composer` now exports `PauseButtonSlot`. Place it at the end of `Composer.Controls` in a custom composer: while nothing is working and Pause is hidden, it keeps Pause's room in the row, so controls such as the model picker keep one width instead of jumping each time Pause comes and goes.
- 801743c: A connected MCP server's own icon now shows as its connector logo. When a workspace connects or enables its own (custom) MCP server, Opengeni reads the `icons` the server lists in its `initialize` reply (`serverInfo.icons`, MCP 2025-11-25), picks the best one for a single tile (theme-neutral before light or dark, vector before a large raster, favicons last), and stores it as the item's logo. Icons go through the same checks as vendored catalog logos (an image type the asset route serves, at most 512 KB, no scripts or external references in SVGs), are fetched through the deployment's outbound network policy with a timeout and at most three redirects, and are served from `/v1/catalog-assets/...`, so the browser never loads them from the server's host. A server without a usable icon keeps its monogram and connects as before. Tool steps from such a server also find the logo by the server's host. Editing a custom catalog item no longer clears its logo. New `@opengeni/capabilities` exports: `mcpServerIcons`, `rankMcpServerIcons`, `decodeDataUriIcon`, `validateLogoAsset`, `catalogAssetObjectKey` and the other logo-asset checks previously private to the catalog scripts; new `@opengeni/db` export `setWorkspaceCapabilityCatalogItemLogo`.
- cb5f4d7: Capability logos now look the same on every surface. `LogoTile`, `CapabilityLogo` and `ConnectionLogo` measure each logo once after it loads (new `logo-fit` helper, cached by URL): a roughly square image with opaque edges is an app icon and fills the tile, anything else is a mark and sits padded on a light plate in both themes, so dark marks no longer disappear on dark backgrounds. An image the browser cannot read (a cross-origin asset without CORS) is treated as a mark. `LogoTile`'s `fit` now defaults to `"auto"`; `"cover"` and `"contain"` still force a treatment. `CapabilityLogo` is now drawn by `LogoTile` (same sizes as before). `ConnectionLogo` exposes the decision as `data-fit` and, like `LogoTile`, shows a missing logo as a monogram on surface-2 in both themes; the `--og-connection-icon-padding` variable is gone and dark marks use `--og-connection-mark-plate` (default `--og-color-fg`).
- ebf148a: Add an `@opengeni/react/meetings-recorder` entry so a host can mount the meeting recorder provider without loading the whole meetings kit at startup.
- a2ae2ce: When the desktop app can't record computer audio, the recorder now says why in the viewer's language instead of showing the desktop app's English sentence under a translated title. The recorder's `error` carries a new optional `reason` (`permission_denied`, `sound_server_unavailable`, `unavailable` or `capture_failed`, the desktop bridge's codes), and `RecorderCaptureError` has the same `reason`. The meetings recorder maps each one to its own message: macOS points to Screen & System Audio Recording in System Settings, Linux says no sound server is running, and the others suggest recording without computer audio. New message keys: `meetings.recorderPanel.computerAudioIsnTAllowed`, `allowThisAppToRecordComputerAudio`, `noSoundServerIsRunning`, `thisComputerCanTRecordItsOwnAudio` and `computerAudioDidnTStart`. The recorder's track labels now size to the longest label, so a longer translation of "Computer audio" is no longer cut off, and the level bars line up.
- cb15454: Meetings pages now show every label in the host's language. Recording lengths ("45 sec"), list states ("Uploading", "Transcribing"), transcript error advice, default speaker names ("Speaker 2", "Microphone", "Shared audio"), the default meeting title and dates come from the message catalog and locale under new `meetings.recordings.*` keys, and language names follow the locale ("Norsk bokmål" in Norwegian). The `@opengeni/react/recordings` helpers take an optional `OpenGeniText` and keep their English output without one. `@opengeni/contracts` adds `recordingSpeakerDefault`, which says what an unnamed speaker label is, so a client can name it in its own language.
- 627bcd6: Meetings started without a title show a local, readable title instead of the server's UTC stand-in. `meetingTitle` is exported from `@opengeni/react/recordings`.
- a5a9336: A meeting page or list showing a meeting that is still being recorded, here or on another device, now reads it every 10 seconds, so it notices when the recording stops and moves on to the transcript instead of staying on "Not finished yet".
- 0da62e3: Meetings menus and dialogs keep Opengeni's styling when a product embeds the meetings pages. They used to open under the host page's `<body>`, outside the scoped stylesheet, so the speaker menu, the visibility menu and the Correct the words dialog showed up unstyled and see-through. Each meetings component now opens its overlays in a styled layer that carries its theme, or in the app's own portal container when there is one.
- 2a29ac1: Meetings say less, more plainly. Explanations of how things work inside (versions, model words, where audio is kept, "pieces of audio") are gone; each state says the one thing that matters and what to do. While recording in the desktop app the panel just says what it records, and an unnamed meeting started on the web is named after when it starts ("Meeting, Oct 26, 12:15") instead of getting the server's "Recording 2026-10-26 11:15 UTC".

  Form dialogs, confirm dialogs and detail sheets read their default Cancel, Close, Loading and Working… text from the host's messages (`formDialog.*`), so a translated product no longer shows them in English.

- a8b429e: Meeting model prices now show only where the workspace pays them. `GET /recording-models` returns `usdPerHour` for a model on the workspace's own key, and for a deployment's model only where its use is charged in credits; otherwise it is null. The recorder's live transcript switch, on web and phone, then says nothing about cost instead of "Uses extra transcription credit", so people whose deployment covers transcription no longer see a provider's list price.
- 627bcd6: The meetings recorder bar is quieter. The meeting language and the live transcript now sit in one small menu beside Start recording, since both are usually set once in Meetings settings; the menu also says what the live transcript costs, so the line under the bar no longer does. A meeting's page no longer repeats "Transcribing" beside its title when the notice under it already says so, a failed transcript offers Transcribe again once, and after Stop the live preview says the transcript replaces it in a minute or two. A host whose meeting language is Bokmål (`nb`) or Nynorsk (`nn`) sees it once in the language list, in Norwegian's place.
- 26c3bc6: Meetings no longer say "Uploading" while a meeting is recorded or after Stop. Audio uploads while it records, so a meeting's page opened from Take notes now shows the recording's clock with Pause and Stop, and after Stop it reads Transcribing on the page and in the list. A paused recording reads Paused in the list, and the recorder's own line after Stop reads "Saving the rest of the audio." on web and phones. A meeting still being recorded elsewhere reads In progress; only a lost connection or a refused upload is called out. Adds `meetingHereStatus` to `@opengeni/react/recordings`; the list label for a recording in progress uses the new `meetings.recordings.inProgress` key instead of `meetings.recordings.uploading`, the recorder's `meetings.recorderPanel.uploadingCountPiecesOfAudio` and `finishingTheUpload` keys become `meetings.recorderPanel.savingTheRestOfTheAudio`, and the meeting page's unused `meetings.detailPage.uploading*` and `stillUploading` keys are removed. Hosts that translate the catalog should rename their `meetings.recordings.uploading` translation to `meetings.recordings.inProgress`, add `savingTheRestOfTheAudio` and drop the removed keys.
- 464f57b: A meeting whose transcript failed before its audio was prepared (for example because no transcription provider was connected yet) no longer says its audio isn't available, and "Transcribe again" works on it. The meeting page now treats audio as gone only once retention deleted it or when none was ever uploaded, and no longer shows that notice while a first transcript is being made.
- 57cfc37: Embedded meetings are transcribed in the workspace's meeting language. `GET …/recording-models` now returns the workspace's `language` (null detects), and the meetings list's recorder starts on it when the host passes no `defaultLanguage`. Until it is known, starting a meeting names no language, so the server uses the workspace's. Before, an embedding that passed no language asked every meeting to detect it, which overrode the workspace setting and could return Norwegian as Danish or Swedish.
- f20b8fb: Every workspace member can now connect their own computer. A signed-in member who can see the workspace's machines connects an "Only me" machine from the Machines page, a chat's machine card or the pairing-code page, and changes, updates or removes their own "Only me" machines. Sharing a machine with the whole workspace still needs a workspace admin, and the whole organization an organization admin; for a member, "This workspace" shows disabled with the reason. Keys, agents, services and credentials acting for someone keep needing `enrollments:manage`, and a refusal is now a plain sentence instead of "missing permission: enrollments:manage". In `@opengeni/react`, `useWorkspaceMachines` adds `canConnect` and `canManageMachine(machine)`, `ConnectMachineDialog` takes `canShareWithWorkspace`, `EnrollmentConsent` takes `allowWorkspaceScope`, and `MachinesDashboard` takes `canUpdateMachine`. The action catalog lists `enrollments:read` as the first permission these routes check.
- d3d8ccf: A computer_open or browser_open that moved the chat to another machine and then failed now says the chat moved, so the agent does not assume it is still on its old machine. Moving a chat in the UI to a machine that has not reported its workspace folder, or whose workspace does not contain the chat's working folder, shows what to do instead of "Try again."
- 8be9be2: Codemode works on a personal ("Only me") Connected Machine used from a chat in another workspace. The machine's runner now keeps the workspace the control plane addressed and replaces only the server address, instead of pointing Codemode at the workspace that enrolled the machine, where the chat's token was refused with 403 "workspace access denied". Takes effect with the next runner release. Machine pickers also say who can use a machine ("Only me", "Workspace") when two listed machines share a name.
- 7bb67e3: Changing a polled read's interval no longer aborts and repeats the read in flight. The session list switches from polling to live list hints shortly after it opens; that switch used to cancel its first `GET /sessions` and send a second one. Now the first read finishes and only the poll schedule changes.
- 936d9e0: Explain Free-credit restrictions in the signed-in workspace and billing page, with a Request review link to the configured support address. Keep sign-in separate from promotional eligibility and refresh review status while the page is visible.
- 69a05bd: Up and Steer now work on a message as soon as it shows as queued. A sent message appears in the queue row at once, but the server needs a moment to place it in the queue, and until the next queue read Up did nothing and Steer was greyed out. Both are now taken immediately and carried out once the message lands: Up pulls it back into the composer, and Steer sends it to the agent now. Neither ever acts on an older message instead, and steering several just-sent messages steers each of them. If the send fails nothing is steered or recalled, and if the agent starts the message first the composer stays as it was and shows "Already sent". Typing or sending another message while Up waits cancels that press and keeps what you typed.
- d8ae831: Keep every chat header on one row of the same height. The automations chip and the parent chat link now sit on the title's row instead of adding a row above it, so the header no longer grows when a chat has an automation or a parent. The automations chip lists each event and the next run on hover, collapses to its icon in narrow headers, and gives up its space before the title does.
- 4651b0d: A Site's sidebar row now moves only when the Site gets a new published version (creation is the first). Messages and turns in its conversations, including a side chat used to edit it, and activity in the chat that created or published it no longer lift it; a publish from any of them still does. Opening a Site, archiving, restoring and the version chip's Undo (a rollback, which adds no version) don't move it either. Opened Sites and Sites with conversations keep their rows in their own project, and session rows are unchanged. `SiteConversationGroup.updatedAt` is now the Site's newest publish. When there are more than 200 Site rows, the limit keeps pinned rows first and then Sites with recent publishes or conversation activity, so a Site whose conversation needs you stays in the sidebar.
- a48504a: The voice control says plainly whether voice can start. While the voice models load it reads "Checking voice" instead of a setup step from a placeholder model, a failed load reads "Voice couldn't load", and where the page may not use the microphone (an embedded frame without microphone permission) or the person blocked it, it says so and offers no Start button that would fail. `useRealtimeModelSelection()` returns `loadState`, which the voice controls take as `loadState`.

  A new feature switch, `addCredits`, controls the new-chat page's "Add credits" button for billing managers. It is on in the `app` and `embed` presets, as before, and off in `companion`, so the Excel add-in no longer shows it; the credits notice still appears when a model's credits run out.

- 70623d6: Phone apps can walk people through starting a voice call with a spoken phrase of their own, such as "Hey Opengeni". iPhone (iOS 18 and later) runs a Siri request when the person says a phrase they taught it under Settings › Accessibility › Vocal Shortcuts; apps cannot create those phrases themselves. The new `WakePhraseGuide` shows the three steps, copies the Siri request that starts the app's call shortcut ("Talk to <name>" by default, so it must match one of the call plugin's phrases), and opens Settings. `wakePhraseSetupAvailable()` says whether the phone supports it. The Opengeni phone app offers it in Settings as Set up "Hey Opengeni". The guide's text uses new `native.realtime.wakePhrase.*` message keys.
- Updated dependencies [931325b]
- Updated dependencies [d649005]
- Updated dependencies [5aa883b]
- Updated dependencies [4488c59]
- Updated dependencies [5a48fe7]
- Updated dependencies [3ee89da]
- Updated dependencies [f6298be]
- Updated dependencies [58d272f]
- Updated dependencies [01188c9]
- Updated dependencies [415c32b]
- Updated dependencies [995c16f]
- Updated dependencies [53e1fe5]
- Updated dependencies [d30a243]
- Updated dependencies [659f5a4]
- Updated dependencies [5b9feb9]
- Updated dependencies [de7087a]
- Updated dependencies [a2ae2ce]
- Updated dependencies [cb15454]
- Updated dependencies [a8b429e]
- Updated dependencies [57cfc37]
- Updated dependencies [f20b8fb]
- Updated dependencies [96502c5]
- Updated dependencies [5f332c1]
- Updated dependencies [24b71c6]
- Updated dependencies [1320698]
- Updated dependencies [54c2f9e]
- Updated dependencies [936d9e0]
- Updated dependencies [4651b0d]
- Updated dependencies [30b9cd2]
  - @opengeni/contracts@5.4.0
  - @opengeni/sdk@5.4.0
  - @opengeni/connect@5.4.0

## 5.3.1

### Minor Changes

- 1988e97: A person can now have the agent do in the chat what they would otherwise do in settings: switch this chat's model, invite someone or share the chat, check their plan, credits and usage, or change a workspace preference. In a chat a person started, `admin_actions_search`, `admin_action_describe` and `admin_action_call` are listed by default and run as the person who sent the message, never with more than that message itself could do: what it may do is frozen with its turn when it is accepted, capped to the chat's workspace. Reads run at once; every change first shows that person a plain confirmation card in the chat ("Invite anna@example.com to your organization as an admin?", one line of the key values, Allow and Cancel, the raw call behind Details), and the API refuses a change that person did not confirm. Only someone signed in to the app itself can confirm changes; with any delegated sign-in (an embed's host-issued token, an external user, another integration's person token) the route only reads unless the deployment sets `OPENGENI_DELEGATED_SIGN_IN_APP_ACTION_CHANGES=true`, which applies to all of them. An Allow given through an API key, a Slack button or a delegated sign-in that isn't turned on never confirms: approvals now record who decided (`decision_by_kind`) and whether they were signed in to the app (`decision_by_signed_in_person`), both fixed with the decision. Calls that create, show, copy or rotate keys, passwords, tokens or other secrets, or carry one in their body, are left to the app unless the session has full access. Contract schemas mark secret fields with the new `secretValue(...)` helper (registry `secretValues`); the catalog generator records them, plus secret-sounding field names, as `secretFields` on catalog entries. Codex and SuperGrok device sign-in starts now have a response schema (`SubscriptionDeviceSignInStart`). A session with full access behaves as before. Scheduled, goal and other unattended turns, API-key and service turns, child sessions and service sessions gain nothing.

  This is on by default for every organization, including existing ones: migration `0971` adds `chatActionsAllowed` (default true) to the agent admin-access setting. Owners and admins turn it off under Security & data > Agents, or with `PATCH /v1/organizations/:organizationId/agent-admin-access` (which now accepts either field). Embedding hosts that draw approvals with `ApprovalSurface` get the same card, with `approvalSurface.allow` and `approvalSurface.cancel` messages to translate; a host can leave the route off by not selecting these tools. The app-action catalog moved to `@opengeni/contracts/app-actions`. `SESSION_ADMIN_ACCESS_TOOL_NAMES` and `SESSION_ADMIN_ACCESS_TOOL_NAME_SET` are deprecated aliases of `SESSION_APP_ACTION_TOOL_NAMES` and `SESSION_APP_ACTION_TOOL_NAME_SET`. `toolReviewFields` takes an optional tool name.

- c5974ea: Agents can set up event triggers: `FirstPartyMcpToolName` adds `event_sources_list` and `events_get`, and `BundledSkillId` adds `builtin:event-triggers`. The timeline shows both tools as "Checked events".
- e3782bb: Automation templates and a "This workspace" event source.

  - **Templates.** A template is where a new automation starts: its message, a schedule without a time zone, and event triggers that name a kind of source. Using one opens the ordinary form filled in; nothing is created until the person saves. `@opengeni/react/automations` ships built-in templates (`builtinAutomationTemplates(t)`, including "Meeting notes"), and `AutomationsPanel` takes `templates` (the host's own), `workspaceTemplates` (offer and save the workspace's saved templates, on by default) and `workspaceEvents` (offer this workspace's own events as a source, off by default). The new-automation view offers "Start from scratch", the host's templates and the saved ones; an automation's menu has "Save as template". `useEventSourceStandIns`, `AutomationTemplateList`, `AutomationTemplateTile` and `AutomationTemplateDialog` are exported for hosts that build their own.
  - **Saved templates.** Workspaces keep the templates their people save: `GET`/`POST /v1/workspaces/:workspaceId/automation-templates` and `PATCH`/`DELETE …/:templateId`, with `listAutomationTemplates`, `createAutomationTemplate`, `updateAutomationTemplate` and `deleteAutomationTemplate` in the SDK. Reading needs `scheduled_tasks:run`, saving needs `scheduled_tasks:manage`; whoever saved a template and workspace admins can rename or delete it (`viewerAccess`). A workspace keeps up to 200; saving more returns 409.
  - **"This workspace" source.** `createEventSource({ kind: "workspace" })` creates the caller's own source for the workspace's recording events (`recording.started`, `recording.finished`, `recording.transcript.ready` and the rest). It reads under the owner's row security, so a trigger only sees the meetings its owner may open.

- 5a256f4: The automation parts in `@opengeni/react/automations` now speak the host's language. Every label, hint and validation message comes from the message catalog under `automations.*`, so `OpenGeniMessagesProvider` translates the trigger editor, event source tiles, delivery log and the "waiting for an event" status like the rest of the UI. The pure helpers take the `t` from `useOpenGeniText()` first. New: `eventSourceChoices(t)`, `eventSourceChoiceName`, `eventDeliveryStatusBadge`, `eventCommonFields(t)`, `eventConditionOperatorLabel`, `eventRowColumns(t)` and `sessionAutomationWaitLabel`. The English-only constants they replace (`EVENT_SOURCE_CHOICES`, `EVENT_DELIVERY_STATUS`, `EVENT_COMMON_FIELDS`, `INBOUND_EVENT_COLUMNS`, `EVENT_DELIVERY_COLUMNS`, `SESSION_AUTOMATION_WAIT_LABEL`) are deprecated.
- 8e20038: `AutomationsPanel` in `@opengeni/react/automations` is a drop-in list, page and form for automations, for hosts that embed chats. Give it the host's `OpenGeniClient` and a workspace, and optionally a chat: in a chat, new automations continue it with its settings; otherwise each run starts a new chat with the workspace's defaults and the owner's access. It turns automations on and off, runs them now, edits and deletes them, and shows recent runs. `eventServers` offers the host's own MCP servers before the person has an event source for them, and `argumentDefaults` fills subscription arguments such as the open project.

  Also new: `AutomationForm`, `AutomationWhenField` (a schedule and event triggers, each optional), `EventArgumentsField` (MCP subscription arguments as fields from the event's JSON Schema, with JSON as the fallback), and the pure automation helpers behind them (`automationCreateRequest`, `automationUpdateRequest`, `automationWhenWords`, `automationWhenSentence`, `automationNextRun`, `sortAutomations`, `deriveAutomationName` and others). The trigger editor edits MCP arguments with those fields, and `EventTriggersField` takes `argumentDefaults` and `actions`. The field's "Optional" marker is translated.

- eb30cb4: Schedules become Automations. An automation runs on a schedule, when matching events arrive, or both. In the web app, the Automations page (formerly Schedules, with the old links redirecting) adds event triggers with only-when conditions, run-once automations, the event runs per hour limit, and Event sources pages to connect GitHub, Slack, Gmail, Linear, Sentry, MCP servers and signed webhooks, with each source's delivery log, replay and test event. Chats that wait for an event show it in the rail and the chat header.

  `@opengeni/react/automations` exports the reusable parts: the event trigger editor and summary, the event source tile, delivery and event rows, and the pure models behind them, for hosts that build their own automation pages.

  Linear and Sentry event sources can be created before their signing secret is pasted: the source shows `awaitingSigningSecret` and refuses deliveries until the secret is set with `updateEventSource`. REST reads of a source include `viewerAccess` (`manage` or `use`), so a UI can show only the actions the caller may take. Sessions carry `waitingForEvents` when an active automation would continue them on an event.

- d806f0f: The cadence picker (`@opengeni/react/ui/cadence-picker`) speaks the host's language. Its labels, weekday and month names, dates, previews and validation messages come from the message catalog under `cadence.*`, so `OpenGeniMessagesProvider` translates it like the rest of the UI. `describeCadence`, `validateCadence`, `formatRunTime` and `describeNextRuns` take the host's text as an optional `text` option, and `timeZoneLabels` as an optional second argument; without it they stay English. Typed cadences (`parseCadence` and the "text" variant) still read English.
- 8da1f14: The ⌘K / Ctrl+K command menu finds Sites in the current workspace. Typing still lists chats first, then matching Sites in a Sites group after them, by title, using the workspace's access-checked Site catalog, so people only see Sites they can open. With nothing typed it shows up to three recently active Sites. Choosing one opens it in the app's Site view, including in the desktop app; ⌘/Ctrl+Enter on the web opens it in a new tab. If Site search fails, the rest of the menu keeps working.
- 8b34e6d: The status area above the composer takes less height, leaving more of the conversation visible on laptops and phones. The wait status is now one chip in the `SessionChrome` row (reason and next check time, details on tap) instead of a two-line banner; pass it with the new optional `wait` prop. Goal pause and clear moved into the goal panel, and a plain file attachment shows on one line.

  `SessionChromeSignalId` gains `"wait"`, so exhaustive switches over it need a new case. The existing goal message keys (`sessionChrome.pauseGoal`, `resumeGoal`, `clearGoal`) are kept and now name the goal panel's buttons.

- dcbe25d: In the desktop app, the computer you're on is now **Computer use**: one on/off switch in Settings > Machines (and at the top of **Connect a machine**) instead of Turn on, Pause, Turn off and the old "Connecting …" card. It shows one state at a time: off (the same whether never set up, turned off, or removed from Machines), turning on, on, a calm "allow Opengeni in System Settings" line with **Open System Settings** while a macOS permission is still missing (not an error: files and commands work meanwhile), or a real problem in red with exactly one fix (**Sign in**, or **Try again** with the server's own message). Before, a computer removed from Machines kept saying "Connecting …" forever with "Couldn't reach the server" although the server had answered; now removal is detected and shows as off, and turning it on registers the computer again. Only a server that really can't be reached says so (new `ThisComputerErrorCode` values `removed` and `signed_out`; failed reads are classified by kind, and `ThisComputerDeps.readMachine` resolves null only when the server answered without the enrollment).

  Off is pause, so it survives restarts and keeps the registration. Turning on is the whole step: it resumes, re-registers or starts the agent as needed, then asks macOS for each missing permission in turn (the system prompt, or the exact System Settings list with the floating guide) and finishes by itself once they are granted; if the person comes back without allowing one, it stops asking until they choose **Open System Settings**. An agent already registered to the workspace from the web app's install command is adopted and shows as on with nothing to do; on macOS the app then runs that same agent as its own helper (same registration, its service turned off) when the app already holds the service's screen permissions or when a missing one is asked for, so one set of permissions, Opengeni's, covers app-shots and computer use. The service runs it again if the helper doesn't stay up, when the app quits, or at the next launch if the helper's program is gone, so the computer never has two agents or none. The sidebar shows a small notice only while computer use turns on, needs a permission, or has a problem. Inside the app, **Connect a machine** no longer offers downloads or **Open app and connect** for this computer; in a browser it is unchanged. `useThisComputer` gains `turnOn`, `turnOff`, `pending`, `asking` and `allowPermissions`; `ThisComputerStatus` gains `requestedPermissions`; `ThisComputerDeps` gains `hostServiceAgent` and `ThisComputer.summary()` gains `handsBackOnQuit`; `@opengeni/react/this-computer` exports `computerUseState`, `computerUsePermissionText` and `useComputerUse`, and the desktop app exports `DesktopComputerUseRow` and `useDesktopComputerUse`.

- 31bca3c: Composer dictation is now a recording with `purpose: "dictation"`, recorded, uploaded and kept by the same local-first pipeline as meetings, so a closed tab, a killed phone app, a dropped connection or a failed transcription never loses what was said. A dictation has one microphone track, is always private, is transcribed and billed as voice input, sends no webhook events, never appears with meetings, and is deleted a day after it is heard. `GET …/recordings?purpose=dictation` (and `listRecordings({ purpose })`) lists the caller's own kept dictations, so the next composer offers text an earlier page left behind.

  `useVoiceInput` records through the recordings API when the client can and the deployment advertises `voiceInput.resumable`, inserts the text once (taking it deletes the dictation first, so two tabs never insert it twice), keeps anything longer than three seconds on Cancel or Escape, and hears a failed dictation again on Retry. It is also exported from `@opengeni/react/recordings`, and `useNativeDictation` in `@opengeni/react-native/recordings` brings the same dictation to phones on the native recorder. A client with only `transcribeAudio` records in memory and sends one request, as before. `ComposerTranscriptionControl` accepts `recordings` and `platform`; `createRecordingStore` and `createOwnerId` are deprecated and ignored.

  The `transcription-recordings` routes and their SDK methods are deprecated, answer with `Deprecation` and `Sunset` headers, and are kept until January 26, 2027. See https://docs.opengeni.ai/integrate/meetings#moving-from-transcription-recordings.

- 1d5bc4e: Event deliveries name what they became: `EventDelivery` adds `eventTypes`, the types of its events each once, and `@opengeni/react/automations` adds `deliveryTitle`, so a delivery log row reads "pull_request.opened" instead of "1 event". Automation pages, notices and menus say "automation" where they meant the whole automation.
- 6acfbd3: Event sources and triggers now say why they are blocked or off as a code clients can word in their own language. `EventSource` and `EventTrigger` gain `statusReasonCode` and `statusReasonDetail`, and `EventTypeDescriptor` gains `unavailableReasonCode` and `unavailableReasonDetail`, next to the existing English sentence (codes are listed in `EVENT_STATUS_REASON_CODES`). `@opengeni/react/automations` adds `eventStatusReasonText`, which words a known code from the host's message catalog (`automations.statusReason.*`) and shows the server's sentence for a code it doesn't know; source and trigger badges, the event source picker and the event type picker use it.
- 6168cfe: A turn that takes more than a second to load its conversation history before the first model request now shows it as a "Loading conversation history" startup step, with its duration in startup timings, instead of a silent wait. `StartupPhase` gains `"history"`.
- bd57ea7: Agents can now find the deployment's reviewed Microsoft integrations (Outlook Mail, Calendar and Contacts, OneDrive and Teams) by the names people use, including Hotmail, Live and MSN, and post a Connect card for them in chat. `SessionIntegrationCapabilityCard` connects the viewer's own personal account in one click (never a workspace account, and reconnecting an expired one, the most recently used one when there are several), installs the reviewed tools for that account, selects them for the chat, lets the agent continue the request, and shows Microsoft's administrator approval link when an organization requires it. It renders in the console and in `SessionConversation` / `OpenGeniChat`, including session-proxy embeds, for people who may connect their own accounts (`sessions:control` plus `connections:personal`, which per-user embed identities get by default). `attachSessionCapability` also accepts an installed integration's runtime server. `ApiIntegrationInstallationSummary` gains `connectionLastUsedAt`, and its `connected` is now true only while the bound connection is active.
- c307566: Sites are edited live in the console's Site view. Every way into a Site opens it there, with its chat beside it; Edit with Opengeni starts a new conversation in that panel. The conversation knows its Site, a publish or restore reloads the preview in place, versions published elsewhere show within seconds, and a version chip offers the history and one-click Undo.

  New public API: `SessionConversation` `onEvent` (each event that arrives after its history loaded); `SiteView` `versionId`, `watch` and `versionControl`; `ArtifactSandbox` `liveState` (Updating or Reconnecting, shown beside the Live indicator or its `liveStatus` replacement) with the `SiteLiveState` type and the `liveUpdating` and `liveReconnecting` labels; `ArtifactSandbox` `frameKey`; `siteConversationContext` in `@opengeni/contracts/site-session-http`; `GET /v1/workspaces/:workspaceId/published-artifacts/:artifactId/current` with `getWorkspaceArtifactCurrent` and `WorkspaceArtifactCurrentResponse` in the SDK, which the Site view uses to check for new versions without reading their history.

- 90e52dc: `RelativeTime` and the time formatting functions now take their words from the message catalog (`time.*` keys), so a host that supplies `messages` and a `locale` gets translated relative times ("Just now", "48 min ago", "Yesterday"), absolute times, dates, weekday and month names and time zone labels. The component reads the nearest messages provider. `formatRelativeTime`, `formatAbsoluteTime`, `formatDate`, `formatShortTime` and `formatExactTime` accept `text` in their options, and `timeZoneLabel` and `inSentence` accept it as a second argument; all stay English when it is omitted. English output is unchanged.
- 2806e31: Meetings show their notes: a notepad that saves as you type during and after the meeting, and the written-up notes above the transcript, with who wrote them and a link to the chat when an agent did. Adds `useRecordingNotes` and `MeetingNotes`.
- 87d1b8a: Embed meeting recording. `@opengeni/sdk/recordings` adds `OpenGeniRecordingsClient` for the recordings API, a local-first `RecordingUploader` that stores chunks on the device before uploading them straight to storage and finishes recordings left behind by an earlier page, IndexedDB and in-memory chunk stores, and `createBrowserRecorder` for microphone plus shared tab or system audio as separate tracks. `@opengeni/react/recordings` adds `useRecorder`, `useRecordings`, `useRecording`, `useTranscript`, `useRecordingPeople` and `useRecordingModels`. Recording response shapes are now published contract schemas.
- 1cac78f: Record meetings on phones. `@opengeni/react-native` adds native microphone capture for iOS and Android that keeps recording in the background and writes AAC chunks to the device before they are uploaded, an on-device chunk store, and an Expo config plugin for the microphone permission and background audio. `useRecorder` from `@opengeni/react/recordings` takes a `platform`, so the same hook drives the browser and the phone recorder; the meeting list and transcript view models are shared from `@opengeni/react/recordings`.

  The SDK's `RecordingUploader` no longer leaves a recording that captured no audio stuck uploading: it removes it, on the server and on the device, and reports `discarded`. Stopping a recording while a chunk is still being uploaded can no longer be lost. The worker accepts AAC tracks and remuxes them before transcription.

  Speakers nobody named now read the same on the server and in every client: `defaultRecordingSpeakerName` from `@opengeni/contracts` gives "Speaker 2" for a diarized `speaker_1` and "Microphone" or "Shared audio" for a whole-track label, and the API's speaker `name` uses it. A speaker counts as named only when it has an assignment (`source` is set). Transcript versions report BCP 47 language tags, so ElevenLabs' `eng` is now `en`.

  An upload refused with 401, 408, 425 or 429 is retried with backoff instead of failing, since a sign-in that loads late or is refreshed, a timeout or rate limiting doesn't make the recording bad. `useRecorder` sends its uploads through the latest client it was given, so a recorder created before the app's sign-in token loaded no longer uploads without it, and only the current recording updates what the hook shows.

  `RecordingUploadStatus.created` says when the server has a new recording, so a list can refresh then and show it while it is still being recorded. `languageName` names ISO 639-2 codes such as `eng` on engines that don't canonicalize them, like Hermes.

- 78ff3e6: The web app has a Meetings page. Record a meeting from the browser (microphone, optionally with a tab's audio), keep working elsewhere in the workspace while it records and uploads, then read the transcript, play the audio, name who spoke, correct a turn, and transcribe again with another model.

  `@opengeni/react/recordings` exports `useRecordingsClient`, which returns the recordings client the hooks use, for calls no hook wraps.

- 9efd19f: The phone app shows and manages a session's full access like the web header does. `SessionHeaderTitle` takes `fullAccess` and then shows a small shield and "Full access" on its status line. The new `@opengeni/react/session-admin-access-model` entry point shares the offered time limits (`ADMIN_ACCESS_DURATIONS`, `adminAccessDurationHours`), `endsText`, `adminAccessGrantedByText` and the grant description between web and native.
- 4695d41: Meetings and dictation share one set of speech-to-text providers. Each model says what it can do and who pays for it (`funding`: a workspace key, a workspace subscription or the deployment). Dictation can use any of them, including Azure Speech and ElevenLabs Scribe. Meetings need a model with word timings; models that return only text (the subscriptions, OpenAI and Azure OpenAI) serve dictation only. `OPENGENI_SPEECH_TO_TEXT_PINNED` makes one model the only one for every use, so a deployment can guarantee where audio goes. Deployment-funded meeting transcripts are charged in credits at the model's price. `GET …/recording-models` adds each model's funding, `dictationDefault` and `pinned`. The voice input provider `azure-mai` is now `azure-speech`; the old name is still accepted.
- 021130f: Phones show the live transcript too. With `liveTranscript: true`, the native recorder streams the microphone to the workspace's live speech model and fills `snapshot.live`, as the browser recorder does. The native capture module sends a 16 kHz copy of the audio (`onPcm`) only while it is asked for (`setLivePcm`); paused audio is not sent, and an app build without the new module records as before with no live text. The live text helpers `groupLiveTurns`, `tidyLiveText` and `tidyPartialText` are now in `@opengeni/react/recordings`, so a phone and a web page join live text the same way.
- ca88f26: New `@opengeni/react/meetings` entry: the ready-made Meetings UI the console uses, so products can embed it. It has `MeetingRecorderProvider` (one recorder above the routes, which also carries out the desktop app's call notifications through `onOpenMeetings` and `onOpenMeeting`), `MeetingsListPage`, `MeetingDetailPage`, `MeetingDefaultsView`, and the pieces they are built from (`RecorderPanel`, `MeetingTranscript`, `MeetingPlayer`, `LiveTranscript`). Pages navigate through callbacks, so any router works. A product can scope the list and new recordings to its own `externalRef` (such as a project), show a `notice` before every start, not offer the live preview, hide the page header, and add its own `details` beside a meeting's transcript. `useRecorder().start` now also takes `externalRef` and `metadata`. `@opengeni/react/testing/meetings` adds an in-memory recordings client for previews and tests.
- f9f0607: Event sources that need no setting up are ready to use. An MCP server the person is signed in to that offers events, a Gmail account they connected and "This workspace" are listed by `GET /v1/workspaces/:workspaceId/event-sources/ready` (`client.listReadyEventSources`) with a key such as `mcp-server:<serverId>`, `gmail:<connectionId>` or `workspace`. A trigger's `sourceId` can be that key: saving adds the person's own source behind it, or reuses the one they have. Agents see them under `readyToAdd` in `event_sources_list` and can set up an automation on one without anyone adding a source first. `AutomationsPanel` and the web app's form offer them in the source picker; `useEventSourceStandIns` takes `readySources`, and stand-in ids are now the ready keys.
- 7d419e2: Add the live transcript preview for recordings. `createRecordingLiveSession`, `appendRecordingLiveSegments` and `listRecordingLiveSegments` on the recordings client; `createLiveTranscriber`, plus `liveTranscript` on `createBrowserRecorder` and `useRecorder`, which stream each track to a live speech model while recording and expose the text in `snapshot.live`; `useLiveTranscript` to follow a recording from another device; and `liveModels` from `useRecordingModels`. Tracks carry a `live` summary, and workspaces can turn it on by default with `settings.recordings.liveTranscript`.
- a9809ee: A blocked "ask before each use" secret use now reaches the person through Opengeni itself instead of depending on the agent to relay a card. The resolver posts Opengeni's own approval card as a human-input request with the new `origin: "secret_use_approval"`, so it appears in the chat, the inbox, a phone notification (without an inline answer) and the Slack thread; an identical blocked use while the request is pending reuses it and never notifies again. The card outlives the turn that hit it. When the signed-in person answers, the grant or denial is recorded and the agent receives the new immediate `secret_use_approval_decided` update telling it to retry the call, or not to, which wakes an idle chat. `SessionHumanInputRequest` gains optional `origin`, `SessionSystemUpdateKind` gains `secret_use_approval_decided`, and `SecretReferenceError` carries `approval: { approvalId, asked }` instead of `approvalCard`; the `approval_required` tool output no longer includes a card and its hint says the person was asked. `request_human_input` refuses `secret-approval:` questions, and agent-relayed approval questions no longer carry authority. Migration 0961 (rolling) adds the request `origin` column and the new update kind, and keeps pending approval cards open in the inbox when a turn ends.
- f3d19a2: Vault items, or single fields of them, can be marked "ask me each time". Agents still see and reference a marked item, but a use that no approval covers stops before any value is read and fails with the new `approval_required` code, and Opengeni asks the person with its own card describing the blocked use (item and field, surface, tool and destination). Only the person the run acts for can answer it, and the answer becomes a grant: allow once, allow in this chat, allow for an hour across the person's chats in the workspace, or deny. The check runs in the shared resolver, so hosted and connected vaults and every surface behave the same. New routes `GET`/`PUT /v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId/approval` and `POST …/approval/grants/:grantId/revoke` (people only for changes), SDK methods `getItemApproval`, `setItemApproval` and `revokeItemGrant`, an "Ask before each use" section on the item page, and migration 0952 (rolling) adding the `secret_approval_rules` and `secret_use_approvals` tables. `SecretUseContext` gains optional `destination` and `lookupDestination`, and secret-use audit rows list the approvals a use relied on.
- 198d6f5: Clicking an image or file in a session's Artifacts panel opens a full-window viewer that steps through the listed artifacts in their current order, respecting search and filters, with Previous and Next buttons, Left and Right arrow keys, swipe on touch, an "N of M" position and Escape to close. Neighbouring images are preloaded, and other artifacts show their existing preview inside the viewer.

  Images in that viewer and in the chat screenshot lightbox can be zoomed and panned: they open fitted (small ones enlarged up to 2x), zoom with Cmd/Ctrl + plus and minus, Cmd/Ctrl + wheel, pinch or the new zoom buttons with a percentage, fit again with Cmd/Ctrl + 0 or Fit, toggle fitted and actual size on click, and pan by dragging or scrolling. While an image is shown, the zoom keys zoom the image rather than the page or desktop window. `LightboxControlLabels` accepts `zoomIn`, `zoomOut` and `fit` labels.

- e509f04: Show Pin and Archive on every sidebar row, including spawned chats and Site rows, on hover or keyboard focus with tooltips, and in the right-click and touch menus. Site rows can be pinned and archived as personal sidebar state (`updateSiteSidebarState`); archiving a Site only hides it from your own sidebar and never unpublishes it. Archive on a spawned chat archives its workstream.

  Session lists for a signed-in person that include or group Site conversations (`siteConversations: "include"` or `"group"`) now leave out conversations of Sites that person archived; a Site's own conversation list is unchanged.

- 4e44f04: The Site view header links to the published Site. "Live ↗" opens the Site's primary public address (in the desktop app, in the default browser) and a copy button copies it, for anyone who can open the Site; an unpublished Site says "Not published", with Publish for people who can publish. `GET /v1/workspaces/{workspaceId}/published-artifacts/{siteId}/publication/link` (SDK `getSitePublicationLink`, contract `SitePublicationLink`) returns a Site's published URL, hostname and status to anyone who can read the Site; the publication's settings stay behind `getSitePublication`. `ArtifactSandbox` and `SiteView` accept a `liveStatus` slot that replaces or hides the header's "Live" indicator.
- 1b99a18: Pressing Up in an empty chat composer pulls your most recent waiting (queued, not yet started) message back into the composer for editing, with its text and attachments and the caret at the end. It is withdrawn from the queue on the server through the same atomic checkout as the queue's Edit action, so it is never sent twice or lost. If the agent took it first, the composer stays as it was and shows a quiet "Already sent". Up keeps its normal caret movement whenever the composer has text, quotes or attachments, during IME composition, with a modifier key, or while the command palette is open. Right after a send, recall waits until that message reaches the queue, so it never pulls back an older one instead. The queue row Up would recall shows ↑ in its Edit tooltip. `ChatComposer` and `useChatComposerController` accept `queuedRecall` (from the new `useQueuedPromptRecall`), and `useTurnQueue` gains an optional `recallTurn`. `SessionConversation` turns recall on when you pass the signed-in person's `viewerSubjectId`, and then only recalls that person's own messages.
- 1534f12: Send feedback on web and in the desktop app attaches screenshots and context, like the phone app. The form offers **Take screenshot** (the desktop app takes a still of its own page without asking, and attaches one as the form opens; browsers use tab capture), **Add image** and paste, up to three images, each removable. `FeedbackDialog` takes `screenshots` and `reportContext`; `webFeedbackContext` (in `@opengeni/react/app/lib/feedback-capture`) reports web or desktop, versions, the page, browser, language, time zone, connection and the last error toasts, which `recordErrorToasts` (in `@opengeni/react/app/lib/recent-errors`) remembers. The desktop bridge gains the `captureWindow` capability and `appVersion`.

### Patch Changes

- de7e142: A Connected Machine whose agent process serves several workspaces no longer shows a failed agent update in the workspaces that did not start it. While one workspace's update runs, the others record a postponement (`update_busy_updating`, retried on the busy backoff and shown as waiting) instead of a failure, and once the restarted agent proves through its update receipt that it runs exactly the target build, every workspace's pending, postponed or failed update for that build is marked succeeded.
- 0676499: Archiving a chat with Pause now removes the one-time waits that continue it or its sub-chats: a run-once event automation that has not run yet, and a one-time scheduled run still ahead. They go in the same transaction as the pause, so an archived chat is never woken by a "wake me when" it was waiting on, and Restore does not bring them back. Repeating automations stay, and Hide for me changes nothing. The archive confirmation says so.
- b4acabd: The Automations panel now says why a run failed or was skipped in words, such as "Skipped because the chat was still busy with earlier work.", instead of showing the recorded reason code (for example `scheduled_session_not_idle`). Skipped runs now show their reason too. The new `automationRunErrorText(t, error)` in `@opengeni/react/automations` turns a run's `error` into that sentence, and a code it doesn't know reads as "Something went wrong with this run." The words are new `automations.run.error.*` message keys, which hosts that translate the catalog can add.
- adeb323: A chat now labels a run of an automation "Automation run" ("2 automation runs" when several arrive together), and the composer chrome calls its source "Automation". It used to say "Scheduled update" and "Schedule" even when an event or a manual run started it. The message keys changed accordingly: `machineInputDisplay.scheduledUpdate` and `machineInputDisplay.scheduledUpdatesCount_other` are now `machineInputDisplay.automationRun` and `machineInputDisplay.automationRunsCount_other`, and `sessionChrome.schedule` is now `sessionChrome.automation`. Hosts that translate these keys should rename their entries.
- 7ae955f: The Automations panel's recent runs pick up a run started with Run now without leaving the page, and keep a queued run's status current while the automation is open.
- e1838ff: A chat's "waiting on" status names every app its automations wait on, not only the first. `SessionAutomationWaitSummary` gains `events`: one entry per source with all the event types its active triggers wait for, in the order the automations were made. The header chip reads "Waiting on GitHub and Gmail" (two names, then "and 2 more"), and its tooltip, the sidebar mark and the hover card list each source's events. With servers that only send `event`, the words are as before.
- 3046e82: `AutomationsPanel` rows read as one line, "Every day at 07:30 · Oslo · Next run: Tomorrow, 07:30", that truncates once instead of twice. On a phone-width panel a row shows only its next run, or the events it waits for. `automations.panel.next` now reads "Next run: {time}".
- 7e88548: `AutomationsPanel` is a styled root of its own, so `compiled.css` styles it in any host. Its menus, pickers and delete confirmation open in a layer of their own under `<body>` that carries the panel's theme, so a host's dialog neither unstyles nor clips them. Inside an app that already provides an overlay container, they open there. The list's loading note and the delete button's pending label come from the messages catalog (`list.loading`, `automations.panel.deleting`).
- ce72530: Scheduled tasks are called automations everywhere people read about them. The agent capability label is "Automations", the permission group is "Automations", timeline steps read "Set up an automation" and "Checked automations", and the repository picker and the archive blocker for a chat an automation posts into say automation.
- f3d19a2: Bitwarden and Vaultwarden connect directly, like the other password managers. A new package, `@opengeni/vaults-bitwarden`, talks to the server's client API with the account's personal API key and decrypts items itself, so connecting needs only the server address, the API key and the master password, entered once. No bridge program or Bitwarden CLI runs anywhere, and nothing has to be unlocked by hand. Opengeni stores the API key, the server's addresses and the account's user key; the master password is used during setup and never stored. Works with Bitwarden Cloud (US and EU), self-hosted Bitwarden and Vaultwarden.

  The account sees My vault and every organization collection it belongs to, each as its own vault, read-only where the collection is. A hide-passwords collection allows plain fields but refuses passwords, one-time passwords and files. Values are read live on every use and never cached. Writes create logins and notes, patch fields and move items to Bitwarden's trash, and a write that raced another client is a conflict instead of an overwrite.

  Breaking for Bitwarden connections only: the Bitwarden credential is now `{ provider: "bitwarden", serverUrl, clientId, clientSecret, masterPassword }`, Bitwarden is no longer a remote provider on the signed `opengeni.vault.v1` protocol (`VaultProviderWireProvider` is `"external"` only), and a connection saved with the old bridge settings reports that it must be removed and connected again. The bridge package is gone. The shared provider operation helpers Keeper and Proton Pass used now live in `@opengeni/vaults`.

- 45cddc7: Hosts that compile the components through the Tailwind v4 source bridge now render them the same as `compiled.css`. The scoped base (a root's own font and colour, scrollbars, selection colour, input cursors and the shimmer's display) moved into cascade layers, so a call-site utility on the same element wins again: the composer's "Connect a model" pill, for example, showed as a filled pill with no visible text. The README's bridge snippet now also imports `@opengeni/react/app.css`, which the session app needs. In `compiled.css` a root's base font and colour now have one class of specificity, like the rest of the scoped base, so a host's element selectors such as `button { font-family }` no longer restyle an Opengeni root.
- 9f6cab2: The published packages now build the `@opengeni/contracts/event-triggers` and `@opengeni/react/automations` entries, so importing them resolves to emitted files.
- 6f6c356: A chat that an automation will post into now says what it is waiting for. Sessions and session list entries carry `automationWait` (`nextRunAt`, the `event` with its `source` and `eventTypes`, and how many `automations` wait), and the lineage read carries `sessionAutomationWait`, for readers who may see schedules. Only automations the reader can see count, and a source that is private to someone else stays unnamed. `sessionAutomationWaitWords(t, session, { now })` from `@opengeni/react/automations` turns it into a sentence ("Waiting for deploy.finished from Deploys. Next run: Tomorrow, 09:00") and a chip label ("Waiting on Deploys"), and falls back to the plain "Waiting for an event" or "On a schedule" for servers without the details. The sidebar mark, hover card, command menu and chat header use it.
- d6c7c4a: The agent now continues on its own after a person finishes setting up a capability from the agent's connect or add-credentials card, instead of waiting for them to say they are done. After setup is verified, the shared chat cards (and the OAuth return handlers) call the new `POST /v1/workspaces/:workspaceId/sessions/:sessionId/capability-continuations` endpoint (`client.continueAfterCapabilitySetup`). The API records one immediate `capability_setup_completed` internal update per card, and only when the capability is now usable in that chat, nobody has written since the card, and the caller is the person whose request it was. The agent sees one short internal update saying the setup is finished and its tools are available. Failed or cancelled setup sends nothing.

  `SessionConversation` and `OpenGeniChat` now render the shared connect card for the agent's OAuth capability requests with no host code, when the person's grant allows every setup step; otherwise the card says the integration can't be connected from here instead of showing a dead end. The session proxy reports a new `chatConnections` client-config field (`false` when its `createSession` hook owns chat tools), and `timelineProps.renderAuthNeeded` still takes precedence.

- 627b2f1: Google Calendar can now be connected from the chat or the Capabilities page, like Gmail: each person connects their own calendar with the deployment's existing Google sign-in app, and the agent can list events in a time range, read one event, check free/busy times, and create, move or delete events. Changes ask first by default, guests are emailed only when asked, and every answer uses the calendar's own time zone. Operators enable it with `OPENGENI_GOOGLE_CALENDAR_ENABLED=true` after enabling the Google Calendar API and adding the `calendar.calendarlist.readonly`, `calendar.events` and `calendar.freebusy` scopes to their Google consent screen.
- c992791: Record other apps' audio in desktop meeting recordings. The desktop app ships a small native helper that captures what the computer plays, apart from the app's own sounds: a Core Audio process tap on macOS 14.2 and later, WASAPI process loopback on Windows 10 2004 and later, and the PulseAudio or PipeWire default monitor on Linux. `@opengeni/desktop` runs it per page and streams its samples over the new `systemAudio` bridge capability, and stops it when the page navigates away, closes or the app quits.

  `@opengeni/sdk` adds `desktopSystemAudioSource`, which turns those samples into a `MediaStreamTrack` the recorder records as its own track, `displaySystemAudioSource` for the browser's shared tab or screen audio, and `defaultSystemAudioSource`, which picks the desktop helper when the app offers it. `RecorderOptions.systemAudioSource` overrides the choice, `RecorderPlatform.systemAudioKind` says which one a recorder uses, and capture failures are reported as the exported `RecorderCaptureError`. `useRecorder` from `@opengeni/react/recordings` exposes `systemAudioKind`.

- 826b002: Agents can find and read recorded meetings with two new first-party tools. `meetings_search` finds the meetings the person can see by words said or in the title, a named speaker, a start-time range or a product's reference, newest first, with each meeting's speakers and the transcript lines that matched. `meeting_read` reads one meeting's details and its transcript as speaker-named, timestamped lines with names and corrections applied, in parts or for a stretch such as 12:00 to 15:00, and reads the live preview while a meeting is still being recorded. Both are searchable (deferred) tools in the knowledge group and need `sessions:read`. The recordings list in the API and SDK also gains `person`, `startedFrom` and `startedTo` filters.
- 4998a79: Meetings can have a language. A workspace sets the language new meetings are in (`recordings.language`), the recorder picks one per meeting, and both the live transcript and the final transcript use it. The live transcript hears only a few seconds at a time, so detecting the language can drift there, which a named language prevents. In a request, `transcription.language: null` detects the language even when the workspace names one (`RecordingTranscriptionRequest`). ElevenLabs gets Norwegian Bokmål and Nynorsk as Norwegian, the one Norwegian it knows. `useRecorder().start()` also accepts `transcription` for one recording. On a meeting page, a speaker can be named "It's me", which links the name to your account so your own voice can be remembered, and naming yourself offers to remember it. When the workspace doesn't recognize voices, naming someone says once that names won't carry over to later meetings.
- 1477b70: On phones, the session access control in the title bar and the Model and effort pill in the composer are now full 44×44 px touch targets. The title bar's narrow-width icon layout no longer shrinks the access control to 32 px on touch screens. The model pill no longer shrinks to a 28 px icon; when its row has less than 44 px of room, it steps aside instead.
- d6c7c4a: New `connections:personal` permission: connect your own accounts and use them in your own chats without administering the workspace. It allows creating, listing and removing only the caller's own (personal) connections, signing in to one's own account through Connect, and turning a reviewed catalog OAuth integration on for personal accounts when it is not on yet (create-only, subject-scoped, no credentials or config, within the organization integration policy). It never covers custom MCP servers, shared or workspace connections, other people's connections, or disabling or reconfiguring integrations. `connections:write` includes it, so existing roles, keys and organization key policies keep their meaning, and workspace Members can now turn such an integration on for their own accounts. Once on, the integration is visible to the workspace's other members as optional; each must connect their own account.

  Organizations can reserve this for admins with the new `personalIntegrationSetup` integration policy setting (`members` by default, `admins`), also in Organization settings → Integrations (migration 0974).

  Embeds: per-user workspaces now get `connections:personal` by default, and the new `identities` option (`"per_user"` or `"shared"`) on the `Opengeni` facade and `createWorkspaceIdResolver` decides it for tenant workspaces: `per_user` adds signed-in tenant users with it, `shared` keeps it off everywhere. `memberPermissions` still overrides both. The shared connect card and the stock conversation's in-chat connect decision use the new `personalIntegrationSetupAccess` helper from `@opengeni/contracts/personal-integration-setup`, offering only a personal connection when that is all the person may do.

- e0f94c2: Record credential preparation, client publication and sandbox client readiness in startup timings. Overlap independent lazy post-provision prerequisites while awaiting all started work before failure or cleanup. Batch timing receipts without changing model input or credential authority.
- 9be821d: The components now work on React 18, which the package has always declared alongside 19. Many of them read `ref` as an ordinary prop, which only React 19 passes through, so on React 18 (and runtimes that behave like it, such as Preact with `preact/compat`) a ref never reached its element. In a narrow embed, where `SessionShell` shows the chat list as a drawer, focus did not return to "Open navigation" after the drawer closed, Radix triggers built with `asChild` lost their anchor, and on some runtimes opening and closing the drawer threw and left the page covered by overlays. Every component that takes a ref now forwards it with `forwardRef`, which works the same on React 18 and 19, and `inert` is written in a form both versions apply. `NewSessionLink` accepts anchor props and a ref, so a tooltip trigger can wrap it. A host that supplies its own `NavigationHost.Link` on React 18 should wrap that link in `forwardRef` so the ref reaches its anchor.
- fcb58f9: The compiled stylesheet now includes the layout utilities the event trigger editor uses, so its form lays out correctly in hosts that load the compiled CSS.
- 314522c: A meeting can be renamed while it records. `Recorder.rename(title)` (and `rename` from `useRecorder`) stores the title with the recording on the device: before the server has the recording it goes out with its creation, after that with the next upload pass, so a dropped connection only delays it; once the recording is finalized it goes straight to the server. The recorder snapshot now has the `title`. `RecordingTransport` may include `updateRecording`, which renaming needs once the server has the recording. The web recorder shows the meeting's name while recording, with Rename.
- 83682c3: Meetings can recognize people by voice. It is off by default. When a workspace turns on `settings.recordings.voiceprints`, each diarized speaker's voice vector is kept with the transcript. People who agreed to be remembered get a voiceprint learned from the speakers named as them, and new transcripts suggest them by name with a confidence. The new routes are `PUT` and `DELETE /v1/workspaces/:workspaceId/recording-people/:personId/voice`. A member agrees with `self` consent, and someone from outside the workspace with `attested` consent. Turning the setting off forgets every voice. `PATCH …/speakers` takes `rejectSuggestions` to turn a suggestion down. The SDK adds `rememberRecordingPersonVoice` and `forgetRecordingPersonVoice`, `useRecordingPeople` adds `rememberVoice` and `forgetVoice`, and `useTranscript` adds `rejectSuggestion`.
- acac580: The session-only React entry no longer reaches `@opengeni/contracts`. Telling a secret approval card from an ordinary question now comes from the new zod-free `@opengeni/sdk/secret-use-approval` subpath (`secretUseApprovalIdFromQuestionId`, `secretUseApprovalQuestionId`, `SECRET_USE_APPROVAL_QUESTION_PREFIX`), backed by `@opengeni/contracts/secret-use-approval-question`; the contracts root still exports the same helpers.
- 34f54fe: Opening a Site no longer moves its sidebar row, just as opening a chat doesn't. A Site row's time is the latest of its conversations, its newest published version, and the chats that published it (the one that created it and any used to edit it), as far as you can see them. Opening a Site still lists it in your sidebar.
- 119f33d: Add independently gated Microsoft Teams agent tools and linked Teams conversations, with durable admission and delivery, private-message authority checks, and workspace setup APIs. Both integrations remain disabled by default.
- c194abb: The desktop app has a Settings → Computer use page that shows, in one place, what Opengeni may do on the computer. The Computer use switch comes first; under it are control the screen (with Screen Recording, Accessibility and Input Monitoring), Google Chrome through the Opengeni Browser extension, the Desktop, Documents and Downloads folders and the Excel add-in, then App-shots and the microphone. Each row has one switch or one action. Turning a switch on asks the system for its permissions in the same step, one after another as each is allowed, or opens the exact System Settings pane when macOS needs the person to change it there, and the row shows Allowed when they come back. A permission the person hasn't allowed is a calm line naming what's missing, not an error, with one Open System Settings action for the page (on the Computer use row, or the row's own for the microphone); red is only for real failures. Turning one off is enforced: with screen control off the app restarts its agent with `OPENGENI_AGENT_SCREEN_CONTROL=off`, and the agent then offers no desktop, reports no screen consent or macOS permission states, starts its browser controllers without a computer backend, asks for no grants, captures nothing and injects no input whatever the connection's consent says; with Chrome off the agent releases its Chrome native-messaging host and starts no attached-browser bridge; with the microphone off the app refuses every microphone request. The switches are on by default and persist in the app's data folder; a settings file that can't be read counts as everything off until a save replaces it (a damaged one is also copied to `.corrupt`). A save or restart that fails shows on its row. The desktop bridge gains `computerCapabilities`, and this-computer status gains `folders`. App-shots settings move from Settings → Machines to this page, which Machines now points to. The agent's `permissions` answer says it honours the screen-control switch; with an older agent the switch shows as unavailable. The `computer-use` page joins the client page list.
- Updated dependencies [c8ddf55]
- Updated dependencies [1988e97]
- Updated dependencies [e7f5d38]
- Updated dependencies [c5974ea]
- Updated dependencies [15b4701]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
- Updated dependencies [eb30cb4]
- Updated dependencies [ce72530]
- Updated dependencies [4c6bf32]
- Updated dependencies [f3d19a2]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [9f6cab2]
- Updated dependencies [6f6c356]
- Updated dependencies [d502ba3]
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
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [68b195d]
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
- Updated dependencies [31c3308]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [b7a14bd]
- Updated dependencies [119f33d]
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
- Updated dependencies [1534f12]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0
  - @opengeni/sdk@5.3.0
  - @opengeni/connect@5.3.0

## 5.2.1

### Minor Changes

- fb72b9d: Any member can now give a session they started their own access, not only organization owners and admins. The app calls it full access. Its agent can do exactly what that person can do in the app and nothing more, and the access ends when the person leaves the session's workspace. The organization's on/off switch is unchanged.

### Patch Changes

- b3a641c: With the `chatList` feature off, the new-chat page no longer shows the project picker or the workspace's recent chats, so an embed that shows a single chat does not list the others.
- c4d18a1: The app no longer reads the workspace GitHub status for a member whose grant lacks `github:use`; it shows no GitHub state instead of a failed 403 request.
- Updated dependencies [fb72b9d]
- Updated dependencies [2d6484c]
  - @opengeni/contracts@5.2.0
  - @opengeni/sdk@5.2.0
  - @opengeni/connect@5.2.0

## 5.1.2

### Minor Changes

- 9c72069: `SessionApp` takes `onSessionState`: it is called with the open chat's status and the events the chat holds (`SessionViewState`) each time they change, read from the stream the chat already uses. A host can show that the agent is working, or refresh what a turn changed, without opening a second stream for the same chat.

### Patch Changes

- Updated dependencies [5d377a7]
  - @opengeni/sdk@5.1.0
  - @opengeni/connect@5.1.0
  - @opengeni/contracts@5.1.0

## 5.0.2

### Minor Changes

- 3083c1e: `createSessionProxyHandler` is now a relay: it forwards every Opengeni route and method inside the resolved workspace as the resolved user, so a product with its own sign-in gives its users the same Opengeni they would get natively (chats and their history, queue, goals, approvals and human input, files, artifacts and Sites, voice, schedules, Knowledge), decided by Opengeni's permissions instead of a list in the relay. Outside the workspace it answers only the bootstrap reads (`GET /v1/workspaces`, `GET /v1/access/me` and `GET /v1/config/client`, each scoped to the resolved workspace); a path naming another workspace is a 403. Path segments are forwarded re-encoded, so keys and subject ids in paths work as in the SDK client. Archived history import (`session-imports`) and browser MCP credential rotation stay refused: only the product's server may write either. Request bodies stream through, Opengeni's statuses, error envelopes and content headers are kept, and SSE streams get heartbeats between events.

  Narrow what users can do with the organization key's permissions, the member's permissions (`addExternalWorkspaceMember`, `updateExternalWorkspaceMember`), and the new `refuse(route, context)` hook for routes Opengeni would allow but the product keeps closed (`route` is `{ method, segments, sessionId }`; return `true` for a 404 or a `Response`). Choose what users see with UI props and `SessionApp` presets. `authorizeSession` now also runs for every request that names a chat in `x-opengeni-session-id`.

  Breaking:

  - Removed options and their replacements: `sessionApp` and `office` (the full app and the Excel add-in work without them), `sessionList` (the list is Opengeni's; pass `listProps={{ mineOnly: true }}` to `OpenGeniChat` or `mineOnly` to `SessionList` for the user's own chats), `archive` (`listProps={{ archive: false }}`), `voiceInput` and `realtimeVoice` (the `voiceInput` and `realtimeVoice` component props), `files`, `sandboxFiles`, `artifacts` and `sites` (permissions, or `refuse` for the routes; `editableLiveUrl` is now a top-level option).
  - Newly reachable for a resolved user, within their permissions: every workspace route, including sandbox file reads (`files:read`, without the old workspace-only rewrite), artifact and Site writes (`artifacts:publish`), schedules, Knowledge, chat cancel, workspace pause and resume, and archive with Pause (`sessions:control`). Without a `createSession` hook the browser now creates chats with Opengeni's own create request (MCP credential updates refused), with `chats` defaults filling what it leaves out.
  - Artifact and Site reads are no longer checked against the session that produced them; `authorizeSession` and Opengeni's `artifacts:read` decide (a product that wants the old check calls `getSessionProxyArtifactAssociation` from `refuse`). `downloadSessionProxySiteHtml`, `SESSION_PROXY_SITE_HTML_MAX_BYTES` and `SessionProxySiteHtmlTooLargeError` are removed; Site HTML keeps Opengeni's sandboxing and download headers.
  - Without `authorizeMutation`, mutations with a `text/plain` or `application/x-www-form-urlencoded` body are now refused as well as cross-site ones.
  - The client config no longer reports `sessionCreation`, `archive`, `realtimeVoice` or `sandboxFiles`; `artifacts` is reported whenever the editor's live socket and the user's grant are available. Stock components treat the missing flags as available and keep honoring them from older relays.
  - Create and other responses keep Opengeni's status (for example `202` for a created chat).

  `@opengeni/react`: `SessionList` gains `mineOnly`, and `OpenGeniChat` forwards it through `listProps`.

- 1320d6c: `SessionApp` takes `resolveLink` and `renderLink`, so a host opens links in agent messages its own way (an artifact on the host's own page, its own link scheme); they are asked before the app's own handling. Object links in an embed no longer resolve against the host page's origin: with the dock on they open in the dock, and with it off (the `embed` preset) they open the object's page in the web app through `openUrl` instead of a broken host-origin link.
- 217ed52: Shared chats on a member's personal machine now show one clear notice when another member's messages or worker results are waiting, naming whose work waits and why. The machine owner can continue with that work in one click; other members see that it waits for the owner before they send.
- ce7f5f3: The Site view's chat panel no longer repeats the Site's conversation list (the sidebar already nests it under the Site row). It shows the open conversation as a regular chat with the model picker, titled in its header, with one New action. The panel can be resized by dragging its left edge or with the keyboard (320 to 720 px, leaving the Site 360 px where there is room), hidden and shown again (choosing a conversation shows it), and its width and hidden state are remembered per person. Adds a reusable `ResizeHandle` window-splitter primitive.

### Patch Changes

- ca3f931: Workspace control events now reach a reader only for chats that reader can see; a cursor-only frame keeps hidden events from stalling the reader. Session start notices accept machinesEnabled so viewers without machine access never request the machine list.
- a9d20b3: Pause chat work atomically before personal archiving, require confirmation for active shared work, and retain explicit hide-only behavior for read-only and embedded proxy clients. Restore does not resume work. Keep sidebar survivors stable across archive completion and overlap independent session response reads without changing transaction or authorization boundaries.
- 929ca26: The session list's archive action reads its "Hide for me" label from the host message catalog again (`sessionList.archive`), so apps can translate or rename it.
- f7dfe7a: The composer's "Opengeni is updating" line now appears only when a session event stream that was live drops and keeps reconnecting. A slow first connection, or a host client that never reports its stream state, no longer shows it or shifts the conversation.
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
  - @opengeni/contracts@5.0.0
  - @opengeni/artifact-tool@5.0.0
  - @opengeni/connect@5.0.0

## 4.8.0

### Patch Changes

- fd953dc: A sub-session question that an agent (such as the parent) answered or skipped is now shown as agent work instead of conversation: one quiet "Asked Target branch → main" row inside the turn's "Worked for" details, which opens to the question, who answered, and the answer. Nothing appears on the person's side any more. Questions a person answered, system skips (a scheduled run's unanswered question), and expired, cancelled or still pending questions look as before. `@opengeni/react/timeline-model` exports `isAgentWorkHumanInput` and `agentWorkHumanInputSummary` so custom renderers make the same decision. React Native: `NativeTimelineMessages.humanInputOutcome` and `OpenGeniNativeLabels.humanInputOutcome` gain an optional `agentSkipped` (defaults to `skipped`), and host overrides of `agentAnswered` still apply to the new row. `OpenGeniNativeSessionView`, which has no turn work details, shows the question as a compact step.
- 3089aaf: Stay calm while Opengeni is updating. The SDK now decodes the parked maintenance answer (`{"error":"maintenance"}`) into an `OpenGeniApiError` with `code: "maintenance"`, `retryable: true` and `outcomeUnknown: false`, without a support reference. `isMaintenanceError` and `OPENGENI_MAINTENANCE_ERROR_CODE` are exported, and `isTransientRequestError` treats the marker as transient.

  In the console and embedded chat, an update or brief outage no longer shows red errors, References, a "Queue needs attention" chip or error toasts. The composer shows one line, "Opengeni is updating. We'll reconnect automatically.", keeps a message sent meanwhile in place with the same idempotency key and delivers it once the API answers, and clears on its own. Reads keep retrying for as long as the maintenance marker lasts. Other transient failures stay calm for two minutes; after that, and for any definitive error, the existing error copy appears. At startup, the web, desktop and embedded apps show "Updating" or "Reconnecting" and continue by themselves when the API is back, with Try again as a secondary action.

- bcce117: The Connected Machine card keeps its Allow button when the agent asks for a machine while the chat already runs on a different one. Before, it showed as done ("This chat runs on …") and gave no way to allow the requested machine.
- e2a641c: Muting replies on a run of a schedule that starts a new chat each time now mutes the whole schedule, so later runs stay quiet. The session menu says "Mute this schedule's replies" there, and `SessionInboxMute` carries an optional `scope`.
- Updated dependencies [3089aaf]
- Updated dependencies [e2a641c]
- Updated dependencies [85fb89e]
  - @opengeni/sdk@4.8.0
  - @opengeni/contracts@4.8.0
  - @opengeni/connect@4.8.0

## 4.7.2

### Patch Changes

- 8301382: A sub-session's question can now be answered by the person or by the parent agent, and the first answer wins. The parent's `child_requires_action` notice now carries each question's id, kind, prompt and option ids and labels (never secret specs), so the parent can answer with `session_human_input_respond` without reading the sub-session's history. The notice now also wakes an idle parent that has no goal. An agent whose answer arrives after someone else's gets `outcome: "unchanged"` with `alreadyAnswered: true`, who answered, and a warning not to answer again; before, it got a success-looking `replayed` result. The `user.humanInputResponse` event records whether a person, API key, agent or the system answered. The agent instructions and the `request_human_input` and `session_human_input_respond` descriptions now say that a parent answers when it can from its task context, leaves questions only a person can answer (decisions, preferences, credentials, approvals) to the person, and never answers on the person's behalf. The conversation now says "Agent answered" instead of "You answered" when an agent gave the answer.
- e423d8f: A parent session now shows the questions and tool approvals its sub-sessions are waiting on, pinned above the composer. Each one names the sub-session that is asking, uses the same answer form or approval card as the sub-session's own page, and sends the answer or decision to that sub-session as if it were given there, with the same permission checks. An unsent answer is shared with the sub-session's page, so it is still there when you switch between them. Several waiting sub-sessions stack under one line ("3 sub-sessions need you") that collapses. Each item links to the sub-session, opened at the moment it asked. A request disappears once it is resolved anywhere, including by the parent agent answering it. The collapsed bar of a question with a deadline no longer shows "[object Object]".
- b3fc68b: Site rows in the sidebar sort only by real activity: their conversations, a new published version, and your own opens. Archiving, restoring or rolling back a Site no longer lifts it for everyone. The console records one open per page that shows a Site: not again when its client is replaced, and not again when a reload, restored tab or Back shows a page where it was already recorded. A page that loads hidden counts once it is shown.
- ee5020c: Text selected and copied from the conversation timeline no longer carries the app's styling. Browsers copy a selection's rich text with the page's computed colours, fonts and the surrounding message's background inlined, so pasting into a document or chat brought the timeline's dark or tinted backgrounds along. The timeline now copies its selection as clean semantic HTML (paragraphs, lists, emphasis, code, links, tables and images keep their structure) together with the browser's own plain text. Selections inside editable fields and outside the timeline keep the browser's default copy.
- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
  - @opengeni/contracts@4.7.2
  - @opengeni/sdk@4.7.2
  - @opengeni/connect@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/connect@4.7.1
- @opengeni/contracts@4.7.1
- @opengeni/sdk@4.7.1

## 4.7.0

### Patch Changes

- f6d388d: Tool steps from connectors whose server lives on another host than the provider (Linear's mcp.linear.app) show the connector's logo again instead of the generic wrench. `connectorLogoIndex` and `connectorLogo` in `@opengeni/react/timeline-model` index each catalog entry under its provider domain, its connection's domain and its MCP server's host, so web, native and embedded surfaces resolve logos the same way.
- 28a7a33: Control+Tab in the desktop app now reaches further back. The list keeps every chat you opened recently (it used to stop at ten), then carries on through your other recently active chats in all your workspaces under a "Recently active" heading, so holding Control and pressing Tab keeps scrolling back in time. Chats that load while the list is open join at the end without moving anything.
- c09c85e: A list row's one-line meta no longer leaves a separator dot with nothing after it on narrow screens. A fact without room for a few letters now drops out whole, and later facts still give way before earlier ones. A Claude account that needs reconnecting no longer shows an empty usage fact (which rendered as a stray leading dot).
- 0b378e8: Keep the "Connect a model" composer pill label readable: the label no longer forces the normal foreground colour onto the primary-coloured pill, which made the text invisible.
- a0a7916: Skill tool rows now say "Read skill" and name the skill, with a distinct skill icon.
- Updated dependencies [31095f1]
  - @opengeni/contracts@4.7.0
  - @opengeni/sdk@4.7.0
  - @opengeni/connect@4.7.0

## 4.6.1

### Minor Changes

- d0eb91c: A session's sub-agents now come back newest first at each level, and the 200-agent cap keeps direct agents and newer ones before deeper or older ones (it used to keep an arbitrary subset ordered by id). `sessionAgentAttention` and `formatWaitingSince` in `@opengeni/react/session-agents-model` give the word a manager must act on (Needs you · 10h, Failed, Stuck, Paused) for web and native. The phone's agents sheet shows that word in place of the time, and folds each agent's own agents behind a count.

### Patch Changes

- Updated dependencies [e7ca55f]
  - @opengeni/sdk@4.6.0
  - @opengeni/connect@4.6.0
  - @opengeni/contracts@4.6.0

## 4.5.0

### Minor Changes

- f838cb7: A deployment that ships its own branded build of the browser extension can now name and link it. Set `OPENGENI_BROWSER_EXTENSION_NAME` and `OPENGENI_BROWSER_EXTENSION_INSTALL_URL`. Agent tool descriptions, setup notes and errors, `/v1/config/client` (`browserExtension`), the machine card's Chrome step and the browser panel's install hint then use that name and install link. Without them, everything still says Opengeni Browser and links its Chrome Web Store page, unchanged.
- 1d65f48: The mobile app can search chats across all of a person's workspaces, like ⌘K on the web. A search button on the home screen opens the chat search, which matches chat titles in the current workspace first and in the person's other workspaces after, labelling each chat from another workspace with its workspace's name. Matching workspaces appear too, so a search can also switch workspace. Opening a chat from another workspace switches to that workspace. `SessionRow` accepts an optional `workspaceName`, and `@opengeni/react` exports the chat-title ranking helpers `rankLabel`, `foldForSearch` and `LOOSE_MATCH_BELOW`.
- 4e8a749: Every Site is a sidebar row, not only Sites with conversations. A Site sits in the project of the chat that created it, and new Site conversations are filed there too. Opening a Site counts as activity for its row, so Sites in use rise and untouched ones sort down. Adds `recordSiteOpened` to the SDK (`POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/opened`), returning `SiteOpenedResponse`.

  `siteGroups[].conversations` can now be 0. An older `@opengeni/react` rail shows such a row with a "0" count until it is updated.

- d0bc2d6: Sites with conversations are rows in the sidebar. Each Site row shows how many conversations it has and their status, sorts by latest activity with other rows and stays in its project. Its conversations are nested under it, collapsed by default, and no longer appear or disappear depending on which session is open. Session lists take a `siteConversations` option: `group` returns complete `siteGroups` for a root page, and `include` lists Site conversations as ordinary rows. Workspace list hints report the viewer's changed Site conversations separately in `siteSessionIds`.
- 0b3b079: Opening a Site from the sidebar shows the Site with its conversations beside it. The newest conversation is open, the others are listed to switch between, and New starts another one in the Site. Opening one of a Site's conversations from the sidebar or from a chat's Site link shows the same view with that conversation selected.

### Patch Changes

- 6f9b6f5: An embedded session app (the `embed` preset) no longer shows Opengeni branding a product did not ask for. The mobile header respects the `brand` switch. A new `starters` switch, off in `embed`, hides Opengeni's suggested first tasks (connect Slack, GitHub, Linear and so on). Someone without GitHub access in the workspace no longer gets a "GitHub status unavailable" toast every time the window regains focus.
- 7e5e08f: Every first-party tool step in the timeline now draws an icon that matches its words (a globe for the browser, a monitor for the screen, a spreadsheet for Excel, an hourglass for waiting, and so on) instead of the generic wrench. The mapping lives in one shared table keyed by tool step, so the web app, React Native and embedded chats all get the same icons; a new step without an icon fails to compile. Connector and custom tools keep their family icon or the wrench.
- debd64e: When something you can fix blocks the agent, the setup card now appears in the same reply, so you no longer have to ask the agent how. The first case is your own Chrome: if the agent needs it and it isn't connected, a Chrome card shows one step at a time: connect a computer, add the Opengeni Browser extension, then continue. The existing card for allowing a chat to use your personal machine now goes through the same path.
- 0910456: Holding ⌘ (Ctrl on Windows and Linux) for a moment in the desktop app shows each pinned chat's ⌘1 to ⌘9 key in place of its time, so the shortcut is discoverable. The numbers follow the order the Pinned section shows. Browsers keep ⌘1 to ⌘9 for their own tabs, so the hint appears only where those keys work.
- 3e4426e: Ride out API rolling deploys and short network blips quietly. The SDK client now retries safe JSON reads (`GET`/`HEAD`) that fail with a transport error or a `502`, `503` or `504`: up to 4 attempts within 5 seconds with jittered backoff, honoring `Retry-After`. Tune it with the new `readRetry` client option or turn it off with `readRetry: false`; mutations are never retried. `isTransientRequestError` is exported for callers with their own retry loop.

  In the console, session, session list and workspace reads, the session event stream and the session lookup page keep showing the loading state or the last loaded view through a transient failure and retry on their own, with no error toast. Only a failure that lasts more than 20 seconds shows an error, once, with a Try again action, and the page keeps retrying in the background and recovers by itself.

- 60e9756: The Site view counts as its own `sites` page in web analytics and client signals, and it declares that its panes scroll themselves inside the app canvas.
- d8179be: The timeline step for starting a worker now reads "Started a worker" instead of "Got help from another assistant", which claimed the help had arrived when the worker had only started. A worker started through `tool_invoke` now shows as the same worker card (title, status, link to the worker) as one started directly.
- Updated dependencies [f838cb7]
- Updated dependencies [debd64e]
- Updated dependencies [3e4426e]
- Updated dependencies [68c3907]
- Updated dependencies [e38f20d]
- Updated dependencies [e22eeca]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
  - @opengeni/contracts@4.5.0
  - @opengeni/sdk@4.5.0
  - @opengeni/connect@4.5.0

## 4.4.1

### Minor Changes

- 2a2acb2: Chats and workspaces across the whole account, from the keyboard. ⌘K now finds chats in all of your workspaces (this workspace's first, others tagged with their workspace) and finds workspaces by name; "Switch workspace…" lists them to pick from. Control+Tab in the desktop app reaches recent chats in other workspaces too. ⌥⌘↑ and ⌥⌘↓ (Ctrl+Alt+↑ and Ctrl+Alt+↓ on Windows and Linux) go to the previous and next workspace, and the workspace picker lists every workspace, grouped by organization, in that order. ⌘K and the desktop Chat menu also offer "Fork chat", which forks from the latest message.
- b58a428: The desktop kit now fits a product whose web app has its own routes and its own server.

  - `webPaths` in the desktop kit's config says where the product's web app shows a workspace, a session, the inbox and settings. The app reads links, reopens the last page and opens notifications and menu commands with it. `parseAppLink`, `parseComputerConnectLink` and `computerConnectUrl` take the same `AppWebPaths`; `OPENGENI_WEB_PATHS` is Opengeni's own web app and stays the default.
  - The "Open in app" handoff uses the app's own scheme: `parseAppLink(url, { scheme })`, `appHandoffUrl(url, scheme)` and `openInAppUrl(url, scheme)`.
  - `allowOtherServers: false` hides "Use another server" on the first-run page, and the app then signs in to its own server only. Its messages name the configured server instead of Opengeni's.
  - `agentPath`, `agentConfigDir` and `adoptStandaloneAgent` pass through to `ThisComputer`, so an app can keep its own agent apart from a separately installed one.

- e3c07bc: Embedded chats can now explain why a message didn't start. When a shared chat still runs on someone else's personal computer and another participant's message is held, `SessionStartNotice` from `@opengeni/react/session-ui` says why in the reader's language, lists the machines they're allowed to use, and offers one recheck once the chat has moved. The saved message is kept and is never sent twice, and access rules are unchanged. `useSessionStart` and the matching model helpers are available from `@opengeni/react/session` for custom layouts, and all text comes from the new `sessionAdmission.*` message keys. The React Native session screen shows the same explanation and machine choices. The hosted app now uses these same components.
- 182eff6: Embedded conversations now show the same startup row as the Opengeni web app while a new chat's first turn starts (queued, preparing the sandbox, contacting the model), instead of a separate "Thinking…" loader that the turn's work row later replaced.

  `SessionConversation` and `useSessionConversation` take a `pendingPrompt` (`{ text, sentAt }`) and accept a `null` session ID. A host whose server creates the session can render the conversation the moment the person sends, with their message and the startup row, and pass the session ID when its create call returns. It stays the same mounted conversation, so the message and startup row stay in place through the hand-over to live history, with no empty "No activity yet." frame. `OpenGeniChat` passes the first prompt the same way when it opens a chat it just created, and `CreatedConversation` now includes `sentAt`.

- 926e0b8: The Excel add-in now has its own Capabilities tile, "Microsoft Excel". The tile explains the add-in, shows the three setup steps and links to the deployment's install page. It uses the deployment's own add-in name and install URL (`OPENGENI_OFFICE_ADDIN_NAME`, `OPENGENI_OFFICE_ADDIN_INSTALL_URL`).

  Agents can find it with `capability_catalog_search` (excel, spreadsheet, xlsx) and post its install card with `capability_authorization_request` (`api:excel-addin`). The card reports ready when the person already has a workbook open with the add-in. `excel_run` and the spreadsheets Skill tell agents to offer the add-in when someone works on a spreadsheet and no workbook is connected. `excelAddin`, `excelAddinCatalogItem` and `EXCEL_ADDIN_CAPABILITY_ID` are exported from `@opengeni/core`.

- 25d1500: Infrastructure-only session events, such as the idle sandbox reaper terminating a shared box, no longer move a session's `updatedAt`, so stopped sessions keep their real last-activity time in the sidebar and session lists (migration 0904). Sessions and session list entries now carry `hasUpcomingSchedules`, and the sidebar schedule icon only appears for schedules that can still fire. A session whose schedules are all paused or expired keeps a distinct "No upcoming runs" schedule button in its header. Editing only a schedule's timing now refreshes open session lists (migration 0905).
- 201c380: Add `homeSessionSections` to `@opengeni/react/session-list-model`: every pinned conversation, then up to fifteen recently used ones (running first), so pins never push recent work off a phone home screen. The mobile app's home screen now lists Pinned and Recent chats under the composer, scrolls through them, and ends with a link to all sessions. Relative times between 45 and 59 seconds now read "1m" instead of "0m".

### Patch Changes

- dd61c8d: The keyboard action list is built on first use (`appActions()` replaces `APP_ACTIONS`), so its icons are never read before the chunk that defines them has loaded, whichever page a visitor opens first.
- efd4df0: Typing with AltGr on Windows no longer fires Ctrl+Alt shortcuts. AltGr+A ("ą" on Polish keyboards) no longer archives the chat, and AltGr+B ("{" on Czech and Hungarian keyboards) no longer toggles the workspace panel. The typed character now reaches the message box.
- 4ff99bd: A turn's answer no longer jumps past the work row when the turn finishes. Once the agent declares its answer, the "Working" row moves above it while the turn is still running, the same place the "Worked for" row takes afterwards, so the answer someone is reading stays where it is.
- 23dfcb2: Keep the chat directory's status-change check free of the rail's status code, so eager pages no longer load the command menu's status marks and the production web build passes again.
- b800b7f: The command menu's chats and the Control+Tab switcher show each chat's status with the sidebar's marks: working, queued, waiting, needs you (and for how long), failed, unread, scheduled, and who started it. Statuses show only while they are known to be current; chats outside the sidebar on screen are read again when a list opens and every 20 seconds while it stays open.
- a506901: Compact session times ("3d") now count calendar days in the viewer's time zone, the same way the long form ("4 days ago") does, so the sidebar and the command menu show the same age for a chat.
- dfa5df0: Opening a chat puts the cursor in its composer: choosing a chat from the command menu or Control+Tab focuses the composer once the menu closes and the composer is ready, and opening or reloading a chat focuses it when nothing else has focus.
- 565253c: The in-flight shimmer on "Working", running tools, running agents, transcription and timeline loading labels no longer keeps the main thread busy. It used to animate a text-clipped gradient, which repainted the text on every frame for as long as anything was running and slowed typing and scrolling in long chats. The new `ShimmerText` slides a masked highlight copy with transforms only, so the compositor runs it. It looks the same and still turns off for reduced motion and forced colors. The `og-shimmer-text` class remains for host markup.
- 343c1aa: Connecting a built-in integration such as Outlook or Gmail now finishes by itself after sign-in: setup loads the reviewed tools and installs them, showing "Finishing setup…" instead of stopping at a "Choose tools" step. Before, closing the window or leaving the page at that step left the account connected with no tools, so agents could not use it. Custom OpenAPI and GraphQL sources still ask which tools to add, and any error brings the manual controls back.
- 524ddde: The desktop app shows an Update button at the bottom of the sidebar as soon as it finds a new version. One click installs it: a downloaded update restarts the app at once, otherwise the download finishes and the app restarts by itself. The app now checks for updates every hour, and the desktop bridge gains an `updates` capability (state, install and change events).
- 73132c4: A form whose save finishes after the person has already left it (for example navigated to another page) no longer closes itself afterwards, so it can't pull them back to where the form was.
- 85c0948: A dialog that its owner closes while a save is still running, such as a confirm that closes and then refreshes the page, can again be dismissed with Escape or a click outside when it is reopened. The form still tells its owner when the save ends, even after it has closed.
- 67ce6ff: Unsent answers to an agent's question are no longer lost when you leave the session and come back. Typed text, Other text and selections are kept in the browser tab until you send or skip, the question expires, or it is answered elsewhere. Secret answers are never kept.
- dbc847f: When an agent is refused a personal (Only me) machine, the Connected Machine card now names the machine it asked for and leads with Allow; other machines and setup fold under "Use a different machine". The card event carries the requested machine as `requestedSandboxId`. If the agent asks again in a later turn, only the newest card stays a full card and earlier ones become one short line, so a chat no longer piles up copies of the same card.
- b81d318: Connecting Outlook or OneDrive no longer dead-ends when a Microsoft 365 organization requires an administrator to approve the app. When Microsoft refuses or the person returns from its "Need admin approval" page, the connect dialog explains that a Microsoft 365 admin can approve the app for everyone and offers an admin approval link to open or copy. The administrator lands on a short confirmation page, and people connect again afterwards. The connect attempt's error message carries the same link, so agents can pass it on.
- 7157f58: Typing in the composer and streaming replies no longer restyle the whole page. Several stylesheet rules used `:has()` on an element other than the one being styled (the composer footer's voice states, the macOS title bar beside a collapsed sidebar, connect-form labels, and the avatar group count), which made Chromium recompute styles for every element on each DOM change: about 35 ms per keystroke in a long chat. The composer footer now carries `data-footer-transcription-capturing`, `data-footer-transcription-attention` and `data-footer-realtime-attention` itself, the session shell carries `data-rail-collapsed`, and `AvatarGroupCount` takes a `size` prop instead of inferring it. A test keeps such selectors out.
- 81a516c: Organizations and workspaces can choose the default voice model. Organization → Models → Voice and a workspace's Voice settings gain a "Default voice model" choice: the model a new voice conversation starts with. A workspace follows its organization's choice unless it picks its own, and "Automatic" keeps the previous behaviour (GPT Realtime when available, otherwise the first available model). People can still pick another model when they talk, and a model someone already picked on their device stays their choice while it remains available.

  API: `OrganizationModelDefaults.realtimeDefaultModel` and `UpdateWorkspaceSettingsRequest.realtimeDefaultModel` (a voice model id, or null for automatic or to follow the organization), and the realtime model catalog marks `workspaceDefault` and `organizationDefault`. The packaged voice control starts with the person's own usable pick, then the workspace default, then the organization default. Rolling migration 0903 adds one nullable column.

- 486abe4: The packaged voice control keeps the model of a voice conversation that is already running when the voice model catalog loads afterwards (for example after reopening a session with a live call). It no longer switches to the workspace's or organization's default model and replaces the running call's controller.
- 9c0c6d1: Keep the public sandbox recovery response compatible now that every managed backend recovers a lost sandbox. `SandboxRecoverySelection.artifactId` is a required native checkpoint id again, as it was before, so existing SDK readers never receive null there. A portable checkpoint that an automatic Retry restores is named by the new optional `SandboxRecoveryProjection.automaticCheckpoint` (`SandboxCheckpointSelection`, whose `artifactId` is null for a portable archive); `checkpoint` is set as well only when that checkpoint is native. The packaged recovery actions read `automaticCheckpoint` first. Older clients still recover these sessions when the next message is sent; they only lack the Retry shortcut for a portable checkpoint.
- 67882a3: Screen readers now read the session header's read-only access mark ("Workspace session access. Visible to people in …") and the Private mark for Personal workspace chats. Both were focusable spans with an `aria-label` but no role, which ARIA does not allow, so assistive technology could skip the label.
- 84c8b32: `createSessionProxyHandler` accepts `sessionApp: true`, so the packaged `SessionApp` runs behind a product's session proxy with no Opengeni credential in the browser (`<SessionApp apiBaseUrl="/api/opengeni" …/>`). The app sees only the resolved workspace and the resolved user's access to it. Its other reads in that workspace, and in chats `authorizeSession` admits, pass through as that user, so Opengeni's permissions decide what they see. A short list of the app's own writes passes too: pinning a chat, moving it to a project, managing projects, the new-chat draft and a chat's tool approval settings. Every other write is refused. Rosters, keys, budgets and administration stay closed even for reads. All existing proxy routes keep their rules, including the host's `createSession` and message hooks.

  Startup error screens no longer name Opengeni, so a product that embeds the app shows neutral text ("Couldn't start", "Under maintenance").

- b7943f4: ⌘B (Ctrl+B) toggles the sidebar, ⌥⌘B (Ctrl+Alt+B) toggles a chat's workspace panel, and ⌃⌘A (Ctrl+Alt+A) archives or restores the current chat. The sidebar and panel buttons and the chat menu show their keys. ⌃⌘S (Ctrl+Shift+S) still toggles the sidebar, and the menu bar shows it because rich text keeps ⌘B for bold.
- 886dc39: Site stills in the artifact library now also require their no-network policy from the frame itself, so supporting browsers block outside requests before the Site markup is parsed.
- f7f7987: Show an actionable error when a connector account was removed while a chat was open. Refresh account choices without replacing explicit selections or retrying a failed message with different credentials.
- 84b1a18: Every subscription account now has exactly one owner: the organization, one workspace, or one person, and it is used wherever it reaches and nowhere else. The per-workspace split between a workspace's own copy of an account and the organization's copy, the preference that chose between them, and "Set aside" are gone; each account has one on/off switch. A migration keeps everyone's access exactly as it was.

  The organization's account lists now include `reach` (who each account reaches), and the organization's Models page lists every account once, grouped by provider, with its owner and a summary of how many are on and how many need reconnecting. Accounts that are turned off fold away when a provider has several, and the page no longer reads every workspace's accounts or each account's access one by one.

- Updated dependencies [e697879]
- Updated dependencies [11e56da]
- Updated dependencies [524ddde]
- Updated dependencies [b58a428]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [d295544]
- Updated dependencies [614c744]
- Updated dependencies [81a516c]
- Updated dependencies [60e031c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [84c8b32]
- Updated dependencies [84b1a18]
  - @opengeni/contracts@4.4.0
  - @opengeni/sdk@4.4.0
  - @opengeni/connect@4.4.0

## 4.3.1

### Minor Changes

- bb438b0: An open chat now jumps to its newest messages after the connection drops, for example when a laptop wakes from sleep, the network comes back or the stream times out, instead of streaming every event it missed. A gap of 16 events or fewer still replays over the live stream; a longer one catches up the conversation and re-reads the working turn's newest steps, or loads the newest window, and the live stream continues from there. The chat also notices a sleep or a returned network right away instead of waiting for the stream's heartbeat timeout. `streamSessionEvents` and `client.streamEvents` accept an optional `beforeReconnect(cursor)` that may move a reconnect's cursor forward; callers that don't pass it keep exactly-once replay.
- 0e135b2: Add a command menu and keyboard shortcuts. ⌘K (Ctrl+K on Windows and Linux) opens one list of chats and actions: recent chats, actions for the open chat (copy link, pin, rename, mark unread, archive) and general actions, with "Search messages" handing the query to full-history search. ⌘/ opens a cheat sheet of every shortcut. One action registry feeds the menu, the chat row and header menus, tooltips and the desktop menu bar, so a key or label is defined once. `@opengeni/react/ui/context-menu` exports `ContextMenuShortcut`, and the prebuilt `@opengeni/react/compiled.css` includes the new menu's styles.

  The SDK's desktop bridge adds the `menuActions` capability with `DesktopMenuAction` and `DesktopMenuSection`, so the desktop app builds its menu bar from the actions the page reports; older desktop builds keep their static menu. Chat title search matches every word of the query in any order, in the title or first message, instead of one literal substring.

- 03947ed: Keep idle session sidebars quiet using authorized commit-level invalidations on
  the existing workspace live stream. Web and desktop refresh dirty loaded scopes
  within the existing 15-second cadence and reconcile on reconnect/focus. Private
  session IDs are filtered with the same RLS and membership fence as list reads.

  Database hosts using a transaction pooler may configure a separate direct/session
  notification URL. Older servers, external host ACLs, injected database handles
  without a listener, and finite HTTP/1 streams keep their polling fallback. The new
  SDK workspace event is transient and does not advance either durable stream cursor.

- cc0792a: Add a Control+Tab recent chat switcher for the desktop app. A quick Control+Tab opens the previously viewed chat and pressing it again comes back; holding Control shows recently viewed chats in the middle of the window, Tab and Shift+Tab move the highlight, and releasing Control opens it. Browsers keep Control+Tab for their tabs, so the switcher only runs inside the desktop app. The prebuilt `@opengeni/react/compiled.css` includes its styles.
- 2963eca: App-shots in the desktop app. When turned on in Settings → Machines, a shortcut (both Command keys on macOS by default) attaches the window you are looking at in another app to the chat you are using: a screenshot plus the window's app, title and the text it shows, including text scrolled out of view. Nothing is sent until you send it, and the attachment can be removed first. The agent receives the window's text as untrusted data inside that message only, so earlier turns stay unchanged. When your computer is connected to the workspace, the agent also learns which machine and window it was, so it can keep working in that window with computer tools; for a browser window it also gets the page address and the browser profile connected through the Opengeni extension, so it can continue in that tab with browser tools. Uploads accept an optional `appShot` description for image files (`uploadFile` in the SDK), and `useFileAttachments` gains `addAppShot`. macOS only for now; Windows and Linux plug into the same capture boundary.
- 1b57d74: Eleven Realtime now listens and replies in the person's language instead of guessing. The voice conversation follows the app language (or the browser's) by default, and the voice model menu has a Language page to pick another one. Realtime controllers accept `getLanguage`, the WebSocket connect request takes an optional BCP 47 `language`, catalog entries for models that need a fixed conversation language list their `languages`, and `@opengeni/react` exports `useRealtimeLanguagePreference`, `realtimeConversationLanguage` and `realtimeAppLanguage`.
- 277c99c: Add Eleven Realtime voice models (v1 max and v1 mini) on the shared WebSocket voice path. Workspaces connect their own ElevenLabs API key under Settings > Models > Voice, and the voice model hands work to the Opengeni session through the same delegation tool as the other voices. The SDK exports `SESSION_REALTIME_MODELS` and `isSessionRealtimeModel`, and the WebSocket answer may set `transcriptAudioTags` so clients strip expressive audio tags from transcripts.
- c236847: Live voice connects and answers faster. The microphone is requested alongside the begin request, WebSocket voices prepare capture while the provider session is minted, and microphone audio leaves the browser in 20 ms AudioWorklet frames instead of ~170 ms blocks. `prestartSessionRealtime` lets a host start voice for a session it has just created while it navigates; the session view's `useSessionRealtime` adopts that call. A delegated turn's spoken result is fetched as soon as the session reports the turn's outcome rather than on the next one-second sync.
- 4fadd37: Realtime voice settings are configurable. Each voice model offers what its provider supports: Eleven Realtime takes its built-in voices or any voice in the ElevenLabs account's My Voices by voice ID, a conversation language and turn eagerness; AI Gateway and SuperGrok models take their built-in voices. A workspace saves settings per model in the new `realtimeVoice` workspace setting (Settings > Models > Voice, or `updateWorkspaceSettings`), and an embedding app can set them per session with `voiceSettings` on the stock voice control, `useSessionRealtime` and `prestartSessionRealtime`, or `getVoiceSettings` on SDK realtime controllers. The realtime model catalog lists each model's `voices`, `customVoice`, `turnEagerness` and `voiceDefaults` and the workspace's saved `workspaceVoiceSettings`, the WebSocket connect request takes `voiceSettings`, and the SDK exports `RealtimeVoiceSettings` and `RealtimeTurnEagerness`. Nothing changes until a setting is chosen.
- 83a467d: Opening a turn's steps now reads large tool outputs as bounded previews instead of whole payloads, so a long turn's steps load in a fraction of the bytes. A row reads its full output once, when it is expanded or when its renderer needs the exact result (screenshots, images, receipts, search results, and custom renderers). Until then its body says the full output is loading, and if that read fails it says the body is a preview and offers Retry. Presented results such as images, published files and Skill or Knowledge writes are still read in full. `listEventPage` and `listEvents` accept `toolOutputs: "preview"`; servers that predate it return exact outputs. `ToolCallItem.outputPreview` and the `ToolOutputPreview` type are new and additive.

  `useSessionEvents().events` now carries those previews for opened turns until a row's exact output is read. A previewed `agent.toolCall.output` payload is marked with `outputPreview` (`truncated: true`, `shape`, `originalBytes`, `previewBytes`); with `shape: "text"` its `output` is the head and tail of the output's text rather than the original value. Code that reads tool outputs from `events` should treat a payload with `outputPreview` as partial, and read the exact event with `listEventPage` when it needs it.

- 67262de: Adds the Ultrafast speed for GPT-6 Astra and GPT-6.1 Sol. When a model offers it, the model picker replaces the Fast toggle with a Speed choice (Standard, Fast, Ultrafast) and shows what the faster speeds cost: 8× usage on a ChatGPT/Codex plan, or the rate multiple on metered routes. A Codex account offers Ultrafast only when its own model list advertises the tier, so the picker shows it only when some account serving the workspace can run it, and an Ultrafast turn is placed only on such an account. Ultrafast requests use `service_tier: "ultrafast"`, and a response served at a lower tier is not counted as Ultrafast. Turns accepted before a model declared Ultrafast keep running unchanged.

### Patch Changes

- 49f2177: Agents can record a browser flow as a video. The new `browser_record` tool starts a recording of a managed or attached browser tab and stops it into an MP4 in the chat's workspace, with a log of when each action happened beside it, and publishes the MP4 so it plays in the chat. Frames are captured only when the page changes, so recording costs almost nothing while a page is still, and the video is encoded on the server, so browser hosts need no video encoder. The SDK adds `startBrowserRecording`, `getBrowserRecording` and `saveBrowserRecording`.
- 579239a: The desktop workspace dock drops its separate header row: the machine status and the maximize and hide controls sit under the panel tabs. Site previews can hide their frame toolbar and take reload and full-screen control from the host.
- 6dd3785: A finished work row that compacted the conversation first now stays folded. The expected "Compacting conversation first" wait no longer counts as an interruption that opens the row.
- bf39d5e: Show ambiguous Connected Machine command outcomes as uncertain instead of successful, including when command details are hidden. Preserve the existing warning to inspect effects before retrying; command execution and retry behavior are unchanged.
- 540d75b: Credit refusals now say that the remaining credit does not cover the model, instead of implying the organization has no credit. Promotional credit can cover some models while another model has none left, so a 402 on Send and a turn that stops with `segmentLimit: "budget_exhausted"` both tell the person to choose a model their credits cover or add credits. The model picker's hint for an uncovered credits-billed model reads "Not covered by your credits" instead of "Needs credits". Message keys and exports are unchanged.
- 20b0aad: The credit refusal notice above the composer shows the server's sentence on its own, without the "API 402:" status prefix or the request reference.
- ee83178: Editable documents and presentations now have a Download action, exporting DOCX and PPTX like spreadsheets export XLSX. `EditableArtifactView` accepts `downloadArtifact` for all modalities; `downloadSpreadsheet` remains supported.
- b20c9b2: Retain bounded agent-update blocker categories/counts and show their report age
  and elapsed holds in Machines and fleet, without disclosing private session IDs. Distinguish controller work
  from native request admission without changing update safety, killing work or
  adding command deadlines. Older agents that cannot identify a blocker remain
  explicitly unspecified. These diagnostics do not establish the cause of an earlier
  hold whose admission snapshot was not retained.
- 70f0522: A chat whose sandbox workspace cannot be restored is no longer stranded: the current archive can be retried on a new attempt, a cold workspace follows the session's selected sandbox backend, and a person can explicitly continue with an empty workspace. The agent then sees a filesystem-discontinuity notice on every later turn, appended at the end of its history.
- 23fed2a: Chat history no longer depends on the server and `@opengeni/react` being released in a particular order. The events API now says when it applies the conversation filter (`X-OpenGeni-Conversation-Filter: 2`, read as `SessionEventPage.conversationFilter`). When a server does not say so, the React history reads keep tool calls in and drop the ones that are not presented in the browser, so an older server that ignores `presentedToolCalls` no longer makes images, published files or Skill cards vanish from history.

  A long turn's model bookkeeping also stops filling the history window: each model call's `agent.model.request` and `agent.model.usage` rows load with the turn's steps. The server keeps the request rows up to a turn's first model response, which draw its startup phase, and every bookkeeping row of a turn that has no other steps, so what the conversation shows is unchanged. `createEmbeddedSessionClient` now keeps `listEventPage` when the base client has it.

- eeab39f: Keep accepted turns recovering while required first-party MCP setup cannot reach the internal API, instead of failing after five attempts during a deployment outage.
- e4915c1: Expose lightweight defaults, workspace-control event, and durable-fanout entry points without changing the existing root exports. Index timeline tool-call lookups by ID to avoid repeated scans while preserving event ordering and fallback behavior.
- 7ed4d2b: Keep Models settings reads across navigation, expose their freshness with an explicit refresh action, and reserve account-detail space while data loads. The client-scoped cache now supports internal mounted-read activity observation without changing the public React API.
- 7517fbc: Organization owners and admins can now connect OpenAI and Azure OpenAI once for the whole organization in Organization settings → Models, next to the other organization providers. OpenAI stores an encrypted API key; Azure OpenAI stores an encrypted key plus the Azure resource endpoint. Admins add the organization's OpenAI model IDs or Azure deployments as its models, and each is checked with the organization's key (and Azure endpoint) before it is saved. The models (`organization-openai/<model>` and `organization-azure-openai/<deployment>`) inherit into the organization's current and future shared workspaces (Personal workspaces stay local), work for sessions created through the web app and the public API, and are billed to the organization's own provider account with no Opengeni credits. `OrganizationModelProviderKind` and `ModelConnectionAccessKind` gain `openai` and `azure_openai`; organization provider connection requests and responses gain an optional `endpoint` (Azure only). A missing or revoked connection fails closed and never falls back to deployment credentials. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `organization-openai` or `organization-azure-openai` provider ids. Rolling migration `0898_organization_direct_openai_model_providers.sql` widens the provider-kind, lifecycle-fact and analytics allow-lists and adds the nullable endpoint columns.

  An organization ElevenLabs key no longer counts as an OpenRouter access policy when a workspace's model restrictions are read.

- 6f150d1: Organizations can set up realtime voice once for every workspace. An organization ElevenLabs key (`elevenlabs` organization provider connection) is used by every workspace without its own key, and organization model defaults gain `realtimeVoice`: per-model voice, language and turn-taking defaults that a workspace uses for a model until it saves its own. The realtime model catalog reports the inherited settings as `organizationVoiceSettings`. Organization custom models stay limited to the model-catalog provider kinds (`OrganizationModelCatalogProviderKind`).
- 427f2a5: Leave existing standalone agents untouched when the desktop app opens. Explicit
  signed-in setup reuses their service and signed installation, preserving macOS
  privacy grants. Service-backed pause/resume persists across logins; quitting the
  desktop does not stop the service. Permission guidance uses the running agent's
  reported grants rather than probing the desktop app. Existing agents require
  the matching native release with structured service inspection before management.
- 6b08cbe: A message that waited in the queue behind running work no longer shows that waiting time as "Worked for". When several queued messages were steered in quickly one after another, each turn showed minutes of work even though it ran for about a second. A turn's queue phase now starts when the work ahead of it ended, not when the message was queued.
- b45d380: Claim compatible waiting Steer messages together, preserving each message while avoiding empty replacement attempts and response rows.
- c6a3493: Each provider row in the realtime model picker has its own `data-testid` (`realtime-model-provider-opengeni`, `-codex`, `-supergrok`, `-gateway`, `-elevenlabs`). The rows were keyed by billing class, so the AI Gateway and ElevenLabs rows, which both bill to the workspace's own key, shared one id.
- 9508318: Live voice models reached over a WebSocket (AI Gateway voices and SuperGrok) now share one path. `POST …/realtime/websocket` and `client.negotiateRealtimeWebsocket` return the provider socket URL, its subprotocols, the wire dialect and the complete provider session configuration, and `createRealtimeWebsocketTransportStarter` opens any of them; the browser no longer carries per-provider configuration. `sessionRealtimeTransportKind` now returns `websocket` for every such model; `gateway` and `xai-subscription` stay in `SessionRealtimeTransportKind` as deprecated names that are no longer returned. `negotiateGatewayRealtime`, `negotiateXaiSubscriptionRealtime` and the two older transport starters keep working and are deprecated.
- a1265ca: A browser or desktop whose sandbox instance is gone no longer keeps the sandbox warm. When a sandbox lost, drained or replaced the instance a browser or desktop controller ran in, the resource stayed `active` forever and its holder kept every later box of that sandbox warm on every provider, so it never idle-drained. The interaction reaper now marks such a resource `lost` (`placement_instance_lost`), settles its pending operations and releases its holder, and the sandbox drains normally. Resources on the current instance are untouched.
- f2ec8b4: Opening a conversation reads the session once again. Since the sandbox terminal started reading its own history, `useSessionEvents` reads the session's head to join the live stream there, a second read of the detail `useSession` already reads fresh. The head read now joins that detail read when one started since the stream began loading, and reads the session itself only otherwise.
- fe99ea2: A sidebar group no longer keeps a row another device archived or changed when that change arrives while an explicit "Show more" has failed or is still loading. The background refresh still leaves Retry and the loaded rows alone, but the group is now reread once the explicit read succeeds. Before, the stale row stayed until some later unrelated change reached the same group.
- 5f5fe8d: Steering several queued messages one after another no longer leaves a stack of empty "Worked for" rows after the messages. A turn that handed over to the next Steer before doing anything but start up did no work of its own, so it now shows no work row; the turn that does the work still shows its own.
- b603f10: Tool review details now list a Gmail selection by subject and sender instead of bare message IDs. `ToolReviewDetailsPage` items gain an optional `detail` line, which `ToolActionReviewDetails` renders under each row.
- Updated dependencies [49f2177]
- Updated dependencies [bb438b0]
- Updated dependencies [0e135b2]
- Updated dependencies [03947ed]
- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
- Updated dependencies [d81c315]
- Updated dependencies [bf39d5e]
- Updated dependencies [fda625e]
- Updated dependencies [2963eca]
- Updated dependencies [374dd81]
- Updated dependencies [91329fc]
- Updated dependencies [46a2ef3]
- Updated dependencies [579239a]
- Updated dependencies [ffe09c2]
- Updated dependencies [1b57d74]
- Updated dependencies [277c99c]
- Updated dependencies [b20c9b2]
- Updated dependencies [70f0522]
- Updated dependencies [c236847]
- Updated dependencies [23fed2a]
- Updated dependencies [e4915c1]
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
  - @opengeni/contracts@4.3.0
  - @opengeni/connect@4.3.0

## 4.2.0

### Minor Changes

- 8c38fe4: An embedded conversation marks itself read while the person watches it.

  - `@opengeni/react`: `SessionConversation` and `SessionConversationView` acknowledge each delivered reply, question or failure for the signed-in person while the timeline is on screen, the page is visible and the window focused (once per reply, never per streamed token, with `acknowledgedThroughSequence` so a late request never hides a newer reply). Unread state, and notifications a server derives from it, then skip replies the person already saw. A hidden timeline, background tab or unfocused window acknowledges nothing; `readAcknowledgement={false}` turns it off. `useSessionReadAcknowledgement` (from `@opengeni/react/session`) does the same for custom layouts. `createEmbeddedSessionClient` passes an optional `updateSessionAttention` through.
  - `@opengeni/react-native`: the native session uses the same acknowledgement implementation, which now retries a transient failure once after a short delay and stops after a permanent rejection.
  - `@opengeni/sdk`: `createSessionProxyHandler` forwards `PUT …/sessions/{sid}/attention` with only `{ unread: false, acknowledgedThroughSequence? }`.

- 5252d01: Embedding products can show their own name everywhere people look.

  - `@opengeni/react`: a `productName` prop on `OpenGeniProvider` and `OpenGeniMessagesProvider` (and `createOpenGeniText`) fills `{product}` in every built-in string that names the product, such as credit labels and recovery notices. Default "Opengeni".
  - `@opengeni/agent-host`: `browserExtension: false` keeps an app's own agent from registering as the Opengeni Browser extension's native host, and removes a registration it made earlier, so another agent on the same computer keeps the extension.
  - The agent's browser and computer helpers now run as `browserd` and `computer-native`, so Activity Monitor and Task Manager show no product name under an app that runs the agent under its own name. Older names beside an installed agent are still found.

- 64e6d6b: Products can draw their own links in agent replies. Pass `renderLink` to `Markdown` or `OpenGeniLinkProvider` and links the agent writes with your scheme (`myapp:order/42`), in-app paths or web URLs reach you with the exact `href`, the link text and whether the link stands alone on its line, so you can show a chip or a card that opens in place. A paragraph holding a standalone link renders as a block so a card is valid there. Returning `undefined` keeps the default link. Without `renderLink`, nothing changes.

### Patch Changes

- a868e17: Repaint retained spreadsheet text tiles when web fonts finish loading so fallback glyphs do not remain cached until the next resize.
- 47eeb80: Site and console chat turns now use the same native authority, tools and execution settings. Remove automatic Site-agent restrictions and forced member profiles; retain normal access checks, approvals and outside-workspace visitor identities. Existing saved member settings and accepted turns are not rewritten. Site authors can explicitly choose narrower ordinary chat settings.
- f6cb82d: Refresh compiled styles to include the vertical padding used by the chat render-error boundary in embedded and published Site conversations.
- 44dc72a: The chat no longer blanks a published Site. The model picker accepts catalog rows without readiness or availability details, and SessionConversation and NewConversation now contain render errors with a "This chat couldn't be displayed" message and a Try again button instead of unmounting the host page.
- Updated dependencies [641e179]
- Updated dependencies [8c38fe4]
- Updated dependencies [e018445]
- Updated dependencies [47eeb80]
  - @opengeni/sdk@4.2.0
  - @opengeni/connect@4.2.0

## 4.1.3

### Patch Changes

- Updated dependencies [404e017]
  - @opengeni/sdk@4.1.2
  - @opengeni/connect@4.1.2

## 4.1.1

### Minor Changes

- 1e16831: `ArtifactSandbox` accepts optional `fullScreen` and `onFullScreenChange` props, so a host can control its full screen, for example from the page URL. Without them the frame manages full screen itself, as before.
- 04019de: Make computer offers client-aware: connect directly inside a desktop app, preserve the account and workspace in an app handoff from the browser, and let embedded products supply their own downloads and connection flow without a terminal-command fallback.
- 843bd39: Products that embed the chat can give people one Send and nothing to learn. With `busySend: "steer"` (web `composerOptions`, native `useOpenGeniNativeSession`), a message sent while the agent works is read as soon as it can, and the stock screens show no Queue choice beside Send and no Queue or Steer words: paused or lined-up messages show as waiting messages, without Steer actions. `offerQueue: true` brings the Queue choice back. `SingleSendWording` applies the same wording around your own composition of the parts.

### Patch Changes

- 34081e9: Explain unconfirmed Connected Machine cleanup and how to recover before retrying an agent update, instead of only saying the idle state is unavailable.
- 395e2ff: Shared chat fixes for embedding products:

  - Counted labels no longer crash on Hermes (React Native), which has no `Intl.PluralRules`. Without it, 1 uses the `_one` form and every other count `_other`, so no polyfill is needed.
  - The voice button no longer names the voice model: it reads "Start voice", "Try voice again" and "Talk live with the agent." The React Native call screen no longer shows the model as its subtitle. Hosts can name the action after their assistant through `messages`, for example `"realtime.realtimeControl.startVoice": "Talk to Ava"`. The keys `realtime.realtimeControl.startVoiceWithLabel`, `tryVoiceAgainWithLabel` and `talkLiveWithModellabel` are replaced by `startVoice`, `tryVoiceAgain` and `talkLiveWithTheAgent`.
  - A turn that stops because automatic capacity recovery ran out now shows a translatable explanation (`lib.format.capacityRecoveryExhausted`) instead of the server's English text. The stored event is unchanged.

- 57e3a3e: Expose actionable Connected Machine credential-expiration diagnostics without overriding live runner authority. The matching native agent pauses refused transport credentials, renews recoverable grants, and persists reconnect-required state only after an explicit permanent renewal denial. Deploy the API and release the updated agent for the complete recovery behavior.
- 9be9a82: Steer reaches the agent within seconds and no longer kills work in progress. A model request still generating when a Steer arrives is cut short: assistant messages the provider had completed stay in history, unfinished text and unstarted tool calls are dropped, and the next request carries the Steer on the unchanged history. Short tool calls finish; long `exec_command`/`write_stdin`, `command_wait`/`command_read` and `session_wait` waits return early with their handle while the work keeps running (`session_wait` reports kind `steer`). The turn then hands over (`turn.superseded` with reason `steer`, `atModelStep: true` and, for a cut-off answer, `cutOffText`) and the Steer runs next. Several Steers are read together, in the order they were sent. Agent Steer (`session_steer`) behaves the same way. Queue (an ordinary Send) is unchanged and still runs after the whole turn. Custom model transports can honour preemption with the exported `isModelPreempted` and `preemptedResponseDone`.

  The web and React Native session screens show a Steer only as the person's message: no status row, chip or "Send now". API callers can still stop the running attempt with `interrupt: true` on `steerQueueItem` on the turn that `steerMessage` returned. A new workspace setting `busySend` (`queue` by default, or `steer`) and a matching `busySend` option on `useComposer`, `SessionConversation` composer options and `useOpenGeniNativeSession` let a product make a normal Send act as Steer while the agent is busy; Cmd/Ctrl+Enter then does the other one.

- Updated dependencies [afff3f9]
- Updated dependencies [04019de]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/sdk@4.1.0
  - @opengeni/connect@4.1.0

## 4.0.4

### Major Changes

- 911c0b1: Apps can now show the components in their own words and languages. Every label, notice and user-facing error in `@opengeni/react` and `@opengeni/react-native` comes from one typed message catalog: pass `locale` and `messages` to `OpenGeniProvider` (or `OpenGeniMessagesProvider` from the new DOM-free `@opengeni/react/messages` entry), with plural forms chosen per language and English as the fallback. `englishMessages` is the full default catalog for translation tooling, and `OpenGeniMessageCatalog` types a complete translation.

  Breaking: default label objects that used to be constants are now functions of the translator (for example `defaultChatComposerMessages(t)`, `SESSION_GROUP_LABELS(t)`, `DEFAULT_SESSION_USAGE_LIMIT_LABELS(t)`, `defaultNativeTimelineMessages(t)`, `DEFAULT_OPENGENI_NATIVE_LABELS(t)`), and exported helpers that produce text take the translator first (for example `buildTimeline(t, events)`, `machineDisplayName(t, machine)`, `orgLabel(t, accountId, grants)`). Get it with `useOpenGeniText()` in components, or `createOpenGeniText()` elsewhere.

### Minor Changes

- f010292: When an agent's Skill, workspace instruction or Knowledge save is refused, the chat now tells the person. A "Not saved to Skills" (or workspace instructions, or Knowledge) row appears beside the agent's reply and stays visible when the turn folds. It appears only for genuine refusals: Agent learning is off where the change would be saved, the chat isn't allowed to make the change, or the agent was started from a Site page. It says why in plain words and links to Agent learning settings or the item. Mistakes the agent can correct and retry itself, such as citing evidence the destination's readers can't see, show no row. Previously a refusal was visible only inside the folded tool call, so a request to remember something could be lost silently.

  The refusal travels as a content-free `_meta["opengeni/learningRefusal"]` fact on the tool result (destination, reason and the targeted Skill ID only), which the model never sees. New exports: `learningRefusalFromToolOutput` and the `LearningRefusal` type from `@opengeni/sdk/learning-refusal`; the full fact from `@opengeni/contracts/learning-refusal`; and `LearningRefusalActionsProvider` and `LearningRefusalPlace` from `@opengeni/react`, which let a host open the right page. `NoticeItem` gains an optional `learningRefusal`.

- e2e75c0: "Use this computer" is now a reusable kit, so any product's desktop app can let its agents work on the person's own computer the way the Opengeni desktop app does.

  - `@opengeni/agent-host` runs the connected-machine agent from a desktop app: it downloads and signature-checks the agent (or uses one bundled in a store package with `bundledAgent`), connects it with a personal enroll token, pauses and resumes it, and on macOS walks the person through Screen Recording, Accessibility and Input Monitoring with a guide window beside System Settings that names the app and ticks off each switch as it is turned on.
  - `@opengeni/sdk/this-computer` holds the shared shapes (status, permissions, error codes, the host interface) and `allowAgentsOnComputer`, which grants the person's agents standing use of their computer, so no chat has to ask again.
  - `@opengeni/react/this-computer` has the screens: the setup dialog (intro, download progress, one permission at a time, done), the sidebar offer, the settings panel with pause, resume and turn off, and the conversation card that turns this computer on from a chat inside the desktop app and, elsewhere, says whether the person's computer is ready or where to get the app. Every word is in the message catalog under `thisComputer.*`, so a product translates them, and names its own agent, with the rest of its text; the look follows the og design tokens, with the kit's own stylesheet in `@opengeni/react/this-computer.css`. What macOS itself calls things (its permission lists and buttons) is quoted in the Mac's own language: English is built in, and a host adds others with a `MacSystemNameCatalog`.
  - The Opengeni web app now uses these screens in the desktop app: the rail offer, a "This computer" panel on the Machines page, and "Use this computer" as the connected-machine card's action when the chat runs inside the desktop app.
  - Conversation steps that find machines, move onto one and back, and use its screen now read plainly ("Looked at the screen", "Typed “hello”") from catalog keys, and a deferred tool run through `tool_invoke` is shown as the tool it ran.

### Patch Changes

- 2a93842: The startup loading animation no longer re-renders in a burst after every update to the conversation around it. Its rotating phrase was re-picked on every render, and each new pick caused another render until the random choice happened to repeat. The phrase now changes only on its five-second timer.
- 9fb9db3: A refused move to another machine now says why. Moving a running chat onto a personal (Only me) machine is refused with the new `chat_busy` code, a machine the person may not use with `personal_machine_not_permitted`, and a machine that is gone with `stale_pointer`; only a real simultaneous move is reported as `concurrent_swap`. Previously every refusal was reported as a concurrent swap. `useMachines` now shows plain copy chosen by the code and never the server's `reason` text, which is written for agents and logs.
- 5581036: The `@opengeni/react/messages` entry is now included in the published package, and the model picker popover shows its own accessible name ("Model and effort", or the host's text) again.
- 79ec9fd: Let a machine owner move a running chat to their personal Connected Machine. Record the click as consent for the current logical turn, retain it across replacement attempts, and recheck ownership and access before each operation without exposing other personal machines or resources. Remove the obsolete busy-chat refusal.
- 5b10fc9: Opening a conversation reads each resource once, and reopening a recently viewed one draws at once.

  - Session, queue, lineage, goal and human-input reads now report the session sequence they reflect (`X-OpenGeni-Session-Sequence`), so the shared event feed's opening burst no longer re-reads what the first read already covers. Opening one conversation drops from 11 requests (16 inside `OpenGeniProvider`) to 7 (8 with the provider's contract check). Older servers that do not send the header keep the previous refresh behaviour.
  - `OpenGeniProvider` no longer runs its reconnect repair on the first open of a conversation; reconnects still repair every view.
  - When the host retains reads (`OpenGeniProvider retainReadsAcrossMounts` or the new `useRetainedReads(client)`), reopening a conversation draws its last timeline, details, queue, goal, lineage and open questions from memory on the first render and refreshes behind it, with no spinner. Retained conversations are kept in memory only, per client object, within the event-browser byte budget; the composer draft is always read fresh.
  - Workspace-scoped client config reads join one request per client and workspace (`readClientConfig`).

- b99865a: Fewer duplicate requests when a conversation starts. Mounted readers of one workspace's model catalog (the conversation and the new-chat composer) now share one catalog and config request, `useAvailableModels` readers share one config request, and the provider's API-contract check joins the deployment config read the conversation is already making instead of sending its own.
- a5a5500: A chat whose model was retired or removed now explains that the model is no longer available and that another model must be chosen, instead of failing its turn with "Activity task failed".
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
  - @opengeni/artifact-tool@4.0.0
  - @opengeni/connect@4.0.0

## 3.4.0

### Minor Changes

- c594c1d: The session list can show only your workstreams. `mineOnly=true` (with `view=page`; SDK `listSessionPage`/`listSessionSummaryPage` `mineOnly`, React `useWorkspaceSessions` `mineOnly`) keeps a workstream when any session in its tree was created by you or received a message you sent directly; agent-relayed messages and service turns do not count. Matching roots list their children in full, totals follow the filter, and the response echoes `mineOnly: true`. The web sidebar's view menu adds an "Only mine" option. A new online index (`session_turns_human_prompt_subject_idx`, built concurrently in rolling migration 0799) keeps the probe to one index lookup per tree session.

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [60191f6]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/sdk@3.4.0
  - @opengeni/connect@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/sdk@3.3.0
  - @opengeni/connect@3.3.0

## 3.2.2

### Patch Changes

- c30cf85: Mark expanded Site headers so the desktop app can keep Back and other actions clear of native window controls without changing inline or browser viewers.
- Updated dependencies [a0c35a1]
  - @opengeni/sdk@3.2.0
  - @opengeni/connect@3.2.0

## 3.1.2

### Patch Changes

- 9f92b60: `markClassicScrollbars` is also available from the small `@opengeni/react/scrollbars` entry point, so an app can mark its document before the first paint without loading the rest of the package.
- e332bc1: A turn no longer fails for good when an image sent earlier in the conversation is briefly unreadable from object storage, for example while a storage replica catches up after an outage. The same turn now retries with the usual short backoff, shows "An image from earlier in this conversation can't be read from storage" while it waits, and sends the same pixels once the image is readable. Bytes that no longer match the stored checksum still fail the turn, because retrying cannot fix them.
- 86df483: Streamed text deltas are now merged when they are written instead of folded afterwards. The turn writer flushes model fragments at most 100 ms apart, sends the first fragment of each item at once, and stores each flush's adjacent plain text fragments as one `session_events` row, so a stream writes about a fifth of the rows it used to and nothing is deleted later. The settled-turn folding pass and its `foldSessionTurnDeltas`, `listSessionDeltaFoldCandidates` and `unfoldSessionEventDeltas` helpers are removed; rows folded by earlier versions stay readable through `coalescedUntil`.

  Reasoning summary parts keep their paragraph breaks wherever fragments are merged: `@opengeni/events` exports `reasoningDeltaSeparator`, and the read-side coalescer now uses it, so consecutive bold headings no longer render glued together after a reload.

- Updated dependencies [17d61c6]
- Updated dependencies [74a259d]
  - @opengeni/sdk@3.1.0
  - @opengeni/connect@3.1.0

## 3.0.0

### Major Changes

- 6339cec: Published Site limits now follow the viewer. Workspace members have no Site caps, only the flood brakes, and keep the embedded agent even when it is off for everyone else. Invited and signed-in people share one Site spend limit ($10 a month by default, or a daily limit) with an optional per-person limit; guests also meet the bot guards (20 conversations per visitor per day, 500 per Site per day, 50 turns and $1 per conversation). Workspace tools reach only members who may use connections, and outsiders never get a subscription-billed model: they use the workspace's credit-billed default or are refused. Sites also meter platform usage (gateway requests, Site SQL rows read and written, stored bytes) against a monthly workspace allowance with overage prices, in `usage_only`, `shadow` or `credits` billing mode, and a deployment-wide monthly spend brake an operator can lift with `scripts/operator/site-platform-brake.ts`. Managers see what each audience can use, readiness warnings with one-click fixes and a View as visitor preview; Site code reads `site.capabilities`. The SDK adds `applySitePublicationFix` and `getSitePlatformUsage`, and agents get `site_publication_apply_fix`.

  Breaking: `agent.guestTools` is accepted but ignored. On published hosts, `not_available_for_viewer` (with the feature name) replaces `site_agents_unavailable`, `site_tools_unavailable` and audience-only Site Data and Site SQL forbidden errors. `details.legacyCode` retains the earlier code for migration; clients must explicitly adopt the new code or read that alias. Ownership refusals keep their own code. `effectiveLimits` now describes non-member limits, never a member's budget. The `free` profile is now `standard` (`free` remains an accepted alias). Limits follow the viewer. These immediate user-directed semantic changes are recorded in the API compatibility exception log, not claimed as a 90-day transition or security exception.

  Migration 0790 adds platform metering, spend windows and verified conversation viewer emails. Migration 0791 is a no-write compatibility checkpoint: legacy stored kinds and overrides stay readable by old releases, with no locked backfill. New writers store standard as free. Request-time normalization ignores old-free defaults in unmarked custom overrides and preserves other owner values; new explicit overrides carry an internal version marker so intentional old-default values are preserved. Existing Sites and old-pod writes pick up the new defaults without republishing. See `docs/published-sites.md` for the exact values and compatibility mapping.

  Members receive no Site budget or session usage-limit stamp. Every published-host conversation gets its own Site Data tools, viewer-bound Site SQL named queries when enabled, and member-only read-only SQL, never management tools. Site agents have no sandbox; publication settings expose no sandbox opt-in. Console-frame tools are narrowed per tool name. Non-member models are explicit and existing subscription conversations are refused. A configurable $0.25 per-turn reservation avoids consuming entire conversation caps; reservation contention returns retryable 429 `site_budget_busy`. React renders audience, budget and platform-brake refusals inline.

  Migration 0790 also adds nullable pending-admission tokens. Funding stays reserved across dispatch, and enqueue transactions verify the token. Crash/unknown-outcome recovery revokes delayed requests and reconciles the locked canonical queue before refunding; neither an idle label nor a timeout can double-allocate funds.

  Keyed Site Start retries also repair sessions whose shell committed but whose first turn did not. Repair reuses the original prompt/model, acquires fresh funding without duplicating conversation or turn counts, and invokes the existing core initialization path.

  Platform usage excludes model spend and defaults to metering only. Site SQL has no monthly row quotas by default and 5 GiB storage per Site. Publishing can return 402 `site_platform_quota_exhausted` only in credits mode and 503 `site_platform_brake_engaged` while the global brake is engaged. The `OPENGENI_SITES_FREE_*` agent settings are deprecated fallbacks for `OPENGENI_SITES_AGENT_*` and `OPENGENI_SITES_GUEST_*` settings.

### Minor Changes

- db3efc5: Sites can now be published to the web. A Site's owner or a workspace admin can give it its own address under the deployment's Sites domain (for example `team-crm-4k9x.opengeni.site`) and choose who can open it: workspace members, invited people who sign in with their email, or anyone, with anonymous visitors as guests. Published Sites keep their Site Data and embedded agent, but their direct tool calls return 403 (tools need a person's session in the console), and only a workspace admin can give the embedded agent workspace tools (guests get them only with `agent.guestTools`). Site code reads the viewer with `site.viewer` and starts sign-in with `site.auth.signIn()`, and no Opengeni credential reaches the Site. Collections gain a guest rule (`none`, `read`, `append`, `own`). Embedded agent use is paid by the organization under a limit profile (free, credits, unlimited or custom) per workspace and per Site. Visitors can report a Site, and managers can take it down and restore it. Breaking: Site HTTP is limited to an explicit operation allowlist (`SITE_OPERATIONS`) in every host, so a console Site that called other API routes through the bridge is now refused; an agent started from a Site page may send workspace API writes only to its tools, its conversations, files and content, and other writes return 403. The SDK adds `getSitePublication`, `updateSitePublication`, `unpublishSite`, `checkSiteHostname`, `takeDownSite`, `restoreSite`, `listSiteAbuseReports`, `updateSiteAbuseReport`, `getSiteLimitProfile`, `updateSiteLimitProfile` and `authorizeSiteViewer`; `ArtifactSandbox` and `SiteView` accept a `viewer`; agents get `site_publication_get`, `site_publication_update` and `site_hostname_check`. Publishing is off until `OPENGENI_SITES_DOMAIN` is set.

### Patch Changes

- 99ab991: Distinguish scheduled runs skipped because their chat is paused from busy-chat overlap, and show the reason and recovery action on the schedule. Explain explicit model-account pins that are turned off for allocation instead of presenting them as temporary quota waits. Reclassification of an existing capacity waiter appends a new, deduplicated status event without changing earlier context, resuming paused work, or replacing an account pin.
- be83e73: Links in an agent's question are now clickable, both on the pending question card and in the answered question in the timeline. Bare `http(s)` URLs in a question's title, prompt and help text open in a new tab, and long URLs or tokens wrap inside the card instead of running past its edge.
- 1c1aa30: Show a turn that must compact its context before its first model request as a calm "Compacting conversation first" step instead of a red "Runtime/model preparation failed" row. The worker records that step as an expected transition, then reopens model preparation for the retried request so its real dispatch is recorded and timed on its own. Compaction raised at stream entry no longer leaves a duplicate running preparation row. Earlier session events are unchanged.
- 2077293: When an agent switches to or runs on someone's personal (Only me) machine that the chat is not allowed to use, the swap now returns a typed refusal (`personal_machine_permission_required` or `personal_machine_not_permitted`) with a plain reason saying how the owner can allow it, and leaves the chat's route unchanged. Previously the tool failed with a raw database error. One-off `run_on` calls give the same reason.
- bfa1754: Import the `SiteViewer` type from `@opengeni/sdk` in the Site view and artifact sandbox, so the published type declarations reference only declared dependencies.
- f7abc0b: Images returned by any tool, such as an integration's capture tool, are now kept the same way as viewed images and screenshots: stored once in object storage with a compact reference in session history, instead of base64 inside each history row. The timeline shows them as images, and the model receives the same image bytes, in the same form, as before. Each image in a result is stored separately, and an image that cannot be stored stays inline exactly as today. Only new tool results change; existing history is untouched. Stored tool images follow the existing screenshot retention period and workspace quota.
- Updated dependencies [9a15dda]
- Updated dependencies [664368a]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
  - @opengeni/sdk@3.0.0
  - @opengeni/artifact-tool@3.0.0
  - @opengeni/connect@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [e8d18da]
  - @opengeni/sdk@2.0.1
  - @opengeni/connect@2.0.1

## 2.0.0

### Major Changes

- 945c247: Variable Sets are replaced by vaults. Secrets live as items with fields in vaults owned by a task, a person ("Only me"), a workspace or the organization, and agents use them through `{{secret:Vault/Item/field}}` references that resolve when a tool, command or browser action runs. Existing Variable Sets were migrated to vaults with the same ids and values.

  Removed: the `/variable-sets` and `/environments` routes (now 410 `variable_sets_removed`), `PUT /sessions/:sessionId/variable-sets`, the `variableSetIds`/`variableSetId`/`environmentId` request fields on sessions, forks, drafts and schedules and `defaultVariableSetIds` on rigs (now 422 when they carry a value), `OpenGeniClient` `listVariableSets`, `resolveVariableSetAttachments`, `createVariableSet`, `getVariableSet`, `getVariableSetVariable`, `updateVariableSet`, `deleteVariableSet`, `setVariableSetVariable`, `deleteVariableSetVariable`, `updateSessionVariableSets` and the deprecated `*Environment*` aliases, their types, and React `useVariableSets`/`useEnvironments`.

  Added: `client.vaults(workspaceId)` (vault, item, field-history, reveal, session vault policy and 1Password routes), the vault wire types, `vaultErrorCode`/`vaultErrorDetail`, `vaultPolicy` on session create and schedules, and React `useVaults`, `useVault`, `useVaultItems`, `useVaultItem`, `useVaultFieldVersions`, `useSessionSecrets` and `useVaultsApi`. Read fields that carried the old selection (`variableSetIds`, `variableSetId`, `environmentId`, `defaultVariableSetIds`) remain on responses as inert, deprecated legacy data.

  This removal ships in SDK 2.0.0 without the usual 90-day deprecation window, as an explicit exception to the API compatibility policy.

### Minor Changes

- c69d74d: The lightbox can page through chat images. Register an element's image with `useLightboxGalleryItem(ref, entry)`; an open lightbox then shows previous/next controls, arrow-key navigation and an "N of M" counter across registered images in the same timeline, resolving each image only when it is shown.
- c08dfcd: Connector tool rows read short. A connector tool call now shows the connector's logo (when the host passes `resolveProviderLogo`, otherwise the usual icon) and a short label such as "List issues · Done". The account is named only when the connector has more than one account in the turn ("Get issue · kari@example.com"); approval cards say "Linear" or "Linear · kari@example.com" instead of the full route label. Tool display metadata gains optional `connector` and `providerDomain` fields, and older events with the long route label show just the tool name. The model still gets the full account description.
- 3822e5f: Turning Opengeni credits off in a workspace (`allowCreditModels: false`) now stops every credit meter, not only credit-billed models. Paid web search and web fetch are no longer offered to the agent (a call already offered is refused with a message that names the switch), knowledge search falls back to keyword results (`fallbackReason: "credits_disabled"`; `mode: "vector"` returns 403), and paid knowledge indexing waits without calling the embedding provider and resumes when credits are turned back on. The model catalog reports a credit model blocked only by the switch with the new availability reason `credits_disabled`, which the React picker labels "Opengeni credits off". Both enum values are additive; clients that do not know them keep their existing fallback.
- 8017d94: Embedded chats no longer carry Opengeni's own defaults into your product. In `SessionConversation` and `OpenGeniChat`, live voice is now opt-in (`realtimeVoice={true}`, or `createSessionProxyHandler({ realtimeVoice: true })`, which now reports `realtimeVoice: true` in the client config), so a call never spends credits or asks for the microphone unless you turn it on. The working indicator says "Thinking…" instead of the console's playful phrases; the new `genieLoading` prop sets your own copy or visual. The session proxy accepts `visitor: true` from `resolve` for anonymous visitors: they get no attach button and their uploads are refused unless the handler sets `visitorUploads: true`. A proxy with `files: false` now also reports uploads off, so the stock composer hides the attach button it could not serve. Explicit `realtimeVoice`, `attachments`, and `files` settings keep working; the Opengeni web app is unchanged.
- c13d080: Add canonical sparse row-height and column-width set/reset commands with live
  spreadsheet projections and immediate, frame-coalesced drag and keyboard
  resizing. Preserve existing dimension-free artifacts and shared artifact
  authority, collaboration, and history.

  Preserve sparse dimensions through native workbook reconciliation and verified
  XLSX materialization, including empty-sheet geometry. Refresh all modality
  kernel distributions together to retain their shared build identity.

  Keep spreadsheet input responsive during delayed saves, retain pending cell
  drafts when refocused, surface independent failures without unsafe overlapping
  retries, and show server sync state separately from local command acceptance.

  Center resize targets on header borders and retain valid covered cells while
  viewport queries change. Show submitted cell input immediately without inventing
  formula results. Support canonical worksheet renaming by double-click or F2,
  with validated Enter/Save, Escape/Cancel, and readable pending/failure feedback.

- 945490f: A connected machine can switch between This workspace and Only me in place, keeping its enrollment, sandbox id, credentials and live connection, so chats, schedules and the installed agent are not registered again. The Machines page gains **Who can use it?**, a dialog that summarizes what one confirmation does, backed by `POST .../machines/:enrollmentId/audience/preview` and `PUT .../machines/:enrollmentId/audience` (`previewMachineAudience` and `changeMachineAudience` in the SDK). Narrowing applies everything in one transaction: the owner's chats stay (shared ones stay shared, usable only by the owner) and their running attempts are re-authorized; other people's chats move off; turns that may no longer use the machine end as cancelled through the terminal `authority_change` interruption; the owner's Workspace schedules on it become Only me (or pause) and other schedules pause; and each affected person gets one inbox notice. Only a second live connection of the same computer blocks the switch. The worker reads the machine's current audience on every operation, so running sessions follow the change without a rebuild and the agent needs no restart or upgrade.
- 0c763f2: Show who sent a message in shared chats. User message items now carry the sender recorded with the message, and `MessageTimeline` (and `SessionConversation` timeline props) accept `renderMessageSender` to draw a small label above the bubble. Nothing is drawn unless the host supplies it, so embedders that have no identity for their users, or do not want attribution, see no change. `MessageSenderLabel` renders an avatar or initials with a name. The web app names other members' messages and leaves your own unlabeled.
- 35fb6fd: Add `useSessionModelAccount`, a provider-neutral hook for a session's model account: the shared accounts and the caller's own personal accounts it may use, choosing one (or automatic selection), and the caller's personal-fallback opt-in. The web app's session header shows the matching account menu for subscription models on the shared subscription core; Codex keeps its existing menu for now.

  Provider-qualified choices and Automatic preserve other providers' bindings. The menu shows stored usage without duplicating the selected account's top summary. Personal fallback is configured separately in Models settings, not in the account dropdown. `ModelPolicyPicker` supports model-identity-only policies with `allowModelOptions={false}`.

- e7f6a53: Native chat media at web parity. `@opengeni/react-native/timeline/previews` adds `createNativePreviewRenderers`: retained-file images load inline (tap for a zoomable full-screen view), and `opengeni-html` / `opengeni-site` previews render in a sandboxed web view sized to their content, with the web's animated "Preparing preview…" surface while the assistant is still writing them, plus incomplete and error states. `createWebMarkdownRenderer` gains `renderImage` and `renderInteractiveBlock`, plain image URLs load, and wide tables scroll sideways with an edge hint. `@opengeni/react/native-previews` exposes the DOM-free pieces (`inlineHtmlDocument`, `previewLoadingDocument`, `loadSiteSnapshot`, `paintPreviewLoading`).
- 412671a: Connect a machine just for yourself. `mintEnrollToken(workspaceId, { scope: "user" })` mints a one-machine command whose machine only the signed-in person can use, in every workspace they can open; `scope: "workspace"` (the default) shares it with the workspace as before. Only a verified person can mint a personal command: someone signed in, or a credential acting as them (a personal API key, or an organization key acting `asUser`). A key, service or agent acting as itself gets `422`. The owner is always the caller, the command is single-use, and the machine is created only if that person is still a member when the command runs. A personal machine reconnects only from the workspace it was first connected from; elsewhere the command answers `409` and changes nothing. The response now says which `scope` and `allowScreenControl` it granted; an older server omits `scope` and mints a workspace command, so check it before showing a personal command. Machine cards label access as "Only me", "Workspace" or "Organization" (`machineScopeLabel`). In the web app, the Machines page and the chat's machine card share one Connect a machine dialog: choose who can use it (Only me by default), screen control (off by default) and Mac, Linux or Windows, copy one command, and the same dialog confirms the connected machine, with Use in this chat from a conversation.
- 63bf721: Prepare a complete personal or workspace MCP connection once, with non-secret headers and protected secret-field mappings. People enter only the missing key in the conversation card; authorized agents that already have credentials use the same native Connect verification and storage lifecycle without another confirmation card.

  Connection, installation and receipt writes are atomic. Exact retries do not repeat verification or create duplicate accounts. The agent path intersects frozen attempt permissions with live ownership, selection, policy and execution fences, and never makes new tools available inside an already accepted attempt. Existing OAuth and explicit account selections remain separate and unchanged.

  Deploy matching API and worker packages before using direct agent setup. Historical attempt catalogs without the frozen permission snapshot do not gain new setup authority.

- 945c247: Human-input cards answer `kind: "secret"` questions. The field is an uncontrolled password input read only at submit, so the value never enters React state, props or storage, and it is cleared after a successful submit and on unmount. It pairs an optional username with the password for password managers, sets `autocomplete` from the spec (`new-password` when Generate is allowed, `one-time-code` with a numeric keyboard for one-time codes), offers show/hide and Generate (filled in the browser with a `SecretsUiProvider` generator, otherwise generated by the server with Undo), shows the `looksLike` hint and a soft, non-blocking pattern warning, and has a Save to select (Only me, This task, This workspace). New `allowedSaveTo` prop on `HumanInputForm` and `HumanInputSurface`: a requested target outside it falls back to the most private allowed one with a note. Submit sends `secretAnswers` next to `answers`. Answered secret questions show "Saved to <vault> › <item>", never a value. Secret references (`{{secret:…}}`, `{{secretfile:…}}`) render as chips in Markdown prose and whole-reference inline code (never in fenced code or links), tool payloads and commands, tool row titles and approval review fields, when a `SecretsUiProvider` is mounted; malformed references stay plain text. New exports `SecretRefChip`, `SecretRefText`, `SecretAnswerChip` and `secretReferenceLabel`, and `SecretsUiProvider` from `@opengeni/react/session-ui`.
- cb9e426: Secrets: every vault row opens again, and 1Password connections are manageable.

  - Fixed vault, item and connection rows that only opened when their title or timestamp was clicked. A page-wide hit-area rule on the Secrets pages covered each row's full-width click target.
  - Connect 1Password is a visible button on Secrets. The flow asks who can use the connection first (Only me, This workspace or the organization), links to 1Password's guide for creating a service account, and names plans in plain words.
  - Settings › Secrets lists 1Password connections with their owner, linked vaults and any token or sync problem. A connection's page links more vaults, replaces the token in place (linked vaults keep working) and disconnects it (unlinks its vaults; nothing is deleted in 1Password). A vault's Replace token action now updates its connection instead of creating a second one.
  - Vaults are grouped by who can use them; a vault linked from 1Password shows which account it comes from and links to it.
  - New API routes `GET /connections/1password/service-accounts`, `PUT /connections/:connectionId/1password/token` and `DELETE /connections/:connectionId/1password`, with SDK methods `listOnePasswordConnections`, `replaceOnePasswordToken` and `disconnectOnePassword`.

- 11779ba: Render per-task usage limits. The timeline shows a `session_usage_limit` stop as a neutral "Usage limit reached" row, a goal paused at the limit explains how to continue, and a refused Send keeps the draft without offering Retry. New exports: `SessionUsageLimitNotice`, `summarizeSessionUsageLimit` and related labels from `@opengeni/react/usage`.
- 844c089: Sites can now save data. Every published Site gets persistent collections of JSON records and files that survive new versions: Site code uses `site.data` (list, get, insert, put, patch with conflict detection, delete, increment, count, batch) and `site.files` (upload, list, url, delete) from `createOpenGeniSiteClient()`, with no credentials in the Site. Each collection's access mode decides what viewers may do (shared, shared read, per viewer, append only), enforced by the server; the Site page itself always acts as a viewer, and an Only me Site's data stays its owner's. Agents and scheduled tasks manage data with new `site_data_*` and `site_files_*` tools, and the Site page has a Data tab for the people who manage the Site. Quotas, write limits, per-Site and per-workspace limits on schema-checking time, and usage metering (usage only, no charge yet) apply. Hosts opt in by giving `createSiteToolBridge` a pinned Site and `fetchResponse`; older hosts report `site_data_unsupported`.
- 7f3f19f: Expose the stock new-conversation controller and view used by `OpenGeniChat`.
  Keep uncertain retries tied to their original creation, preserve newer text,
  files and model choices through native draft handoff, and support opt-in
  voice-first creation without a synthetic prompt. The session proxy preserves
  browser creation idempotency keys unless its server hook supplies its own.
  Simple embeds continue to use the same one-component API.
- ef1f78d: Subscription accounts and their usage limits no longer have to reload from scratch every time you come back to them. `useCodexAccounts` and `useSuperGrokAccounts` now share reads per `client` object: readers mounted at the same time share one request, failed reads are never served as cached data, and a pin or activation re-reads every mounted list for that workspace even when the component that made it has unmounted. New `OpenGeniProvider` prop `retainReadsAcrossMounts` (default off) keeps those reads across navigation, so a remount renders the last accounts at once and re-reads them in the background; retained reads are dropped when `client` changes or the provider unmounts. Without it nothing is served to a later mount. **Host action item:** set `retainReadsAcrossMounts` only if every signed-in person gets their own `client` object; leave it off when one client is reused across people. `useCodexAccounts().refreshUsage({ maxAgeMs })` reuses live usage readings only when every listed account was read within `maxAgeMs` and shares one provider read between concurrent callers, and the result exposes `liveUsageUpdatedAt` (the oldest account reading). No new exports.
- 27db84b: Timeline rows for spawning an agent, messaging one, and every update one sends back now name the agent and link to its session. Agent updates inside a delivery pill render as named rows with a two-line preview and the full text on expand, and the pill says who sent them ("Update from API audit", "3 updates from API audit and Docs"). Repeated progress notes from one agent fold into its latest note. A child result still reads "Result from …", never "finished". `MessageTimeline` and `SessionConversation` accept `resolveSessionTitle` for current titles; without it, rows use the title given at spawn, then the generic labels.
- a91718c: Workspaces can turn off Opengeni-credit models in one step. The workspace setting `allowCreditModels: false` (`PATCH /v1/workspaces/:id/settings`, SDK `updateWorkspaceSettings`) blocks every model billed in Opengeni credits, including credit models added to the catalog later. The allowlist stays as it is, whether the workspace has its own or follows its organization's. Session creation, messages, schedules, goals, child agents and the omitted-model default all honor it, and so do credit-funded live voice and voice input (where credits are billed; voice input falls back to a connected subscription) and managed video generation. Paid web search and knowledge embeddings are not affected. The model-policy responses report it as `allowCreditModels`; saving or removing an allowlist never changes it. The React live-voice control labels a model refused for this reason "Credits off".

### Patch Changes

- 04ebc42: A session whose next turn the runtime refused to start (an admission block, such as a rejected database claim) no longer reads as "Waiting on you" with nothing to answer. It now reads as "Stuck" in the session header, lists, hover details, sub-agent rows and the timeline divider, on the web and in the native app. The web session notice is titled "Stuck" and, for a rejected claim, says nothing is needed from the person. The native session screen shows a matching card with a Try again action (Resume), and its composer offers Send instead of Stop while the session is stuck. Session list entries now carry `admissionBlock`, and the SDK's `Session` type gains the optional `admissionBlock`. New helpers `sessionDisplayStatus` and `sessionAdmissionBlocked` return the display status `blocked`, and the native timeline messages gain `stuckTitle`, `stuckBody`, `stuckAccessBody`, `stuckRetry` and `stuckRetryFailed` for hosts that swap copy.
- 14a9340: A person's question asked while the agent is working or waiting always gets a visible answer. `wait_for_input` is refused (as a tool error, at most twice per turn attempt; a resumed or retried attempt starts again, and the check fails open if it cannot decide) when the turn answers a person's message and the agent has not written any visible reply yet, so a status drafted only in reasoning is written out before the turn yields. `prepareAgentTools` accepts the new `inputWaitReplyGuard` option for this check.

  In the timeline, a reply the agent wrote before more tool work and a wait stays visible after the "Worked for" row instead of folding into it: a turn that answers a person and ends with only progress notes keeps its first and last message visible, and the notes between them still fold.

- d4c17b3: Automatic agent updates no longer close open browsers. Agents before 0.1.58 close every managed browser when they restart, so the automatic updater now leaves such a machine on its current agent while it still has a managed browser that may be open, and looks again on the usual busy backoff. The machine card shows "Update to vX postponed: open browsers would close" and notes that updating by hand closes them; "Update now" still works. Agents from 0.1.58 on keep their browsers across a restart and are updated as before.
- d8a4e8e: The browser viewer no longer loops on ending a lost attached-device browser. A refusal (4xx) is not retried, and transient failures retry at most three times with backoff; previously a 409 was re-sent on every registry refresh, about one request per second.
- f36484a: Let slow browser inventory reads finish when refresh events arrive. Combine pending refreshes into a trailing read, while still canceling obsolete reads when the workspace, client, or enabled state changes.
- 5f8d2e2: A turn blocked on model subscription capacity now reads "Limit reached" on its work row, with one quiet line saying it continues automatically, instead of a long separate warning. Once the turn resumes or settles the warning is gone, and "Worked for" no longer counts the time spent waiting for capacity. The `waiting_capacity` session status label is now "Limit reached". Waits that need a person (an ineligible pinned account, a disallowed model, accounts disabled for allocation, or an account that needs reconnecting) keep their recorded reason.
- dfee983: Show fallback text for Codex capacity waits when optional detail text is absent or empty, instead of rendering a blank notice.
- 561c701: Chat messages now show a single newline as a line break, so an agent reply written on three lines (1, 2, 3) shows three lines instead of "1 2 3", the same as ChatGPT or GitHub comments. This applies to agent replies, progress notes, and your own messages in the Opengeni web app and in embeds that use the default `MessageTimeline` renderer. Code blocks, lists, tables, quotes, and headings render as before. Custom renderers can opt in with the new `softLineBreaks` prop on `Markdown`.
- 7f2446f: The session workspace dock no longer polls the machine fleet for viewers who cannot read it. `<SandboxWorkspace>` and `useSandboxWorkspaceTabs` accept `machinesEnabled` (default `true`); Opengeni's web app passes the viewer's `enrollments:read` grant. A 401, 403, or 404 from the fleet read now stops the 15-second poll until the read is disabled and re-enabled or explicitly refreshed. In the web app, Organization → Billing reads workspace budgets four workspaces at a time and requests this month's usage only for workspaces the viewer belongs to, and a refused Add people candidate list is not requested again when the page remounts.
- 4532435: Codex Apps keeps working when a workspace routes models through its organization's Codex accounts. The workspace's designated Apps account now loads, and its token refreshes persist, through the Apps designation itself instead of the model-routing pool; that authority still reaches only the designated account, owned by this workspace and its current owner. Turning Apps off (`DELETE /v1/workspaces/:workspaceId/codex/apps`) now works in every routing mode, so `apps.canDisable` is accurate.

  Apps no longer posts an authorization card every time it sets up a turn. A card appears only when an Apps tool call needs one, at most once per turn, and an unusable designated account is reported with the new `tool.auth_needed` reason `designated_credential_unavailable` instead of `refresh_failed`. Clients should treat unknown reasons generically, as before.

- 4f18b7e: Preserve bounded first input while an explicitly PTY-capable cold terminal acquires its viewer grant, then deliver it once at the existing negotiated readiness boundary. Plain SSE and transport downgrade fences remain unchanged.
- c960696: Long orchestration runs no longer stack identical "Agent update / Worked for / Waited" rows. Two or more consecutive quiet cycles (routine input, work without a visible reply, a finished wait) fold into one row such as "8 updates over 5h 54m · 30 steps", with the latest wait reason under it on the web. Expanding it shows the original rows unchanged. Visible replies, people's messages and the turns they open, failed turns, approvals, live work and the current wait are never folded.
- c9f2c11: A context compaction cut short by its own attempt's cancellation (for example a turn worker draining during a deploy) is no longer reported as a summarization failure. The worker records `session.context.compaction.skipped` with `reason: "interrupted"`, keeps any explicit `/compact` request pending for the recovered attempt, and lets the cancellation recover the same turn as before. The timeline shows "Compaction interrupted" with retry copy instead of "Couldn't compact conversation history".
- dc38882: Focus rings on the compaction Details toggle and the image lightbox keep a visible outline in forced-colors mode, and the precompiled stylesheet no longer ships unused utilities generated from code comments and sandboxed visualization CSS.
- fb298ad: A failed context compaction now appears once, on its timeline landmark: "Couldn’t compact conversation history" with one short recovery step and a single Details control (the provider response, rejected parameter and request ID, or the recorded error text when there is no provider rejection). The failed turn chip names the outcome instead of the raw provider text, no separate notice repeats the failure, and the landmark no longer overflows the timeline. `ContextCompactionItem` gains an optional `failureDetail` with the same turn's recorded failure text.
- 64c4dd3: The default model picker in `SessionConversation` now disables other providers' models in a session locked to Codex remote compaction, as the API refuses them there, instead of offering them.
- 285968f: A GitHub organization member who isn't an owner now gets a clear path instead of a dead end. Opengeni explains that an organization owner must approve and lets them send the request through GitHub. Afterward they see a calm "Waiting for your GitHub organization owner" state, and the GitHub card updates on its own once an owner connects the organization. An organization owner who approves on GitHub lands on a page explaining the one remaining step instead of an expired-link error. Published `.patch` and `.diff` files now have a "Copy command to apply these changes" button. It copies one `curl … | git apply` command that uses the existing short-lived authenticated download link, which expires in 5 minutes. `ConnectSetup` shows the owner-approval state, and `RetainedArtifactLoader` accepts an optional `{ prefer: "url" }`.
- 121f6ed: A new chat without a goal no longer logs failed `GET .../goal` 404s in the browser console. `GET /v1/workspaces/:workspaceId/sessions/:sessionId/goal?absent=null` answers 200 `null` for a goal-less session (without the opt-in the 404 is unchanged, and a missing session is always 404). The SDK adds `findGoal`, which sends the opt-in and resolves `null`; the session proxy forwards it. `useGoal` reads through `findGoal` when the client has it (falling back to `getGoal` and its absorbed 404 otherwise), and no longer re-reads a goal-less session when the stream's opening events race the first read, so an embedded Opengeni chat makes one successful goal read per new chat. A goal set later still arrives through its `goal.*` event.
- f3aa7f2: `recentSessionsForHome` now lists only top-level conversations, so sub-agent sessions no longer push your own recent work off the home screen.
- 5baab79: Stop Modal boxes that only an unused browser or desktop keeps warm. After the general sandbox idle grace without use (agent tool calls, a person's input, or a visible live view's heartbeat), a saveable browser is checkpointed and suspended, other browsers and desktops are released as `idle_released`, and the box saves `/workspace` and stops. Saved browsers resume on demand, also when the desktop they were shown in has stopped.
- 810d1d9: Add targeted current-human tool resolution and invocation without whole-workspace
  provider discovery. Fence caller, pinned Site and selected live action policy
  after awaited physical credential authorization. Preserve success/unknown
  outcomes through cleanup failures, prevent stale retries on contradictory
  transport flags, and retain Site entry pins through Codemode refresh. Preserve
  live account authority, versioned executable-effect one-shot approval
  bindings, optional full-definition preconditions, and explicit legacy discovery.
  SDK calls use the targeted path by default; older APIs require explicit catalog
  mode. Upgraded Site hosts adapt saved legacy bundles using bounded manifests.
  Raw/local target approvals bind existing executable/configuration authority
  instead of public catalog presentation. Retained catalog clients also veto
  uncertain stale retries; explicit malformed pins are never silently omitted.
  The host also separates executed stale-named provider diagnostics from legacy
  Site retry control without rewriting saved bundles or changing success outputs.
  Deploy rolling migration 0686 before enabling the new API and matched SDK/host.
- ea7428d: Machine cards and the machine page now describe the agent in plain words and never contradict the health badge. A second agent process refused days ago is quiet history on the machine page instead of a red banner; only one being kept out right now shows a calm heads-up. An update postponed because the machine was busy reads as postponed with an "Update now" action, a failed update to the version already installed is not shown at all, and real failures say why and offer "Try again" only when it can help. The machine page gains an Agent panel with the build, the update action and the connection.
- da01634: Add a provider-neutral explicit model-account choice for sessions and a person's own personal-fallback opt-in. `GET`/`PUT /v1/workspaces/{workspaceId}/sessions/{sessionId}/model-account` lists the workspace's shared accounts and the caller's own personal accounts with whether each can be chosen, and sets or clears an explicit choice; the database still decides, so a personal account is accepted only for its owner's private session or Personal workspace while personal accounts are allowed. An ownerless session lists every account as not choosable (`session_has_no_owner`). `GET`/`PATCH /v1/organizations/{organizationId}/me/model-account-preferences` reads and changes only the caller's own opt-in; turning it on wakes waiting turns so they can fall back at once. The SDK gains `getSessionModelAccount`, `setSessionModelAccount`, `getModelAccountPreferences` and `updateModelAccountPreferences`. Rolling migration 0729 adds the owner's own access to their preferences row and nothing else. `isCodexAccountEvent` in `@opengeni/react` also matches `model_account.selection.changed`.
- 4cb80a9: Show Anthropic Opus, Sonnet and Haiku models without the redundant Claude word (`Opus 5.5`), since the maker mark already says Claude. Older names such as `Claude 3.5 Sonnet` and the Models settings pages are unchanged.
- 9a78a48: The native app shows and changes the person's pinned chats, the same personal pins as the web. The sessions list has a Pinned section above the projects, the home list shows pins first as the web home does, and both load every pin through the pin-aware session page. A long press on a row (or its accessibility action) pins or unpins it: the row moves at once and the server's answer settles it. `SessionRow` and `SessionRowList` gain `onTogglePin`, and pinned rows show a small pin mark. `@opengeni/react` adds `applySessionPinToLists`, which moves a session between the pinned and ordinary lists and ignores pin answers older than the row shown. The native messages gain `pinned` and `pinFailed`.
- 38b1ba1: Use Opengeni in product copy and Slack manifest defaults, add a clearly labeled staging icon, and accept both current and historical Slack installation names without rewriting saved credentials or receipts. Expose the Opengeni chat facade while preserving the existing `OpenGeni` export and public identifiers.
- 6960770: Opper is a first-class model provider with the same three rails as OpenRouter and Vercel AI Gateway. `OPENGENI_OPPER_API_KEY` adds reviewed EU-pinned `opper/vertexai/gemini-3.8-flash-eu` and `opper/aws/claude-sonnet-4-6-eu` routes billed in Opengeni credits at the exact Opper-reported cost +5% (reviewed list price as fallback); workspace admins can connect their own Opper key (`workspace-opper/…`, billed to their Opper account) and add exact custom Opper ids; organization owners can connect Opper once for every shared workspace (`organization-opper/…`). The SDK adds `listWorkspaceOpperCustomModels`, `createWorkspaceOpperCustomModel`, `deleteWorkspaceOpperCustomModel`, `ModelConnectionAccessKind`, and `"opper"` as an organization model provider kind. Opper management keys (`op-mak-…`) are rejected with an explanation. Deployment catalog documents accept a reviewed `opperModels` list. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `opper`, `workspace-opper`, or `organization-opper` provider ids; move a hand-written Opper registry entry to `OPENGENI_OPPER_API_KEY`. Rolling migration `0636_opper_model_providers.sql` widens the provider-kind, lifecycle-fact, and analytics allow-lists.
- 78c28ca: When a sandbox is gone, all of its background commands now settle at once. The reaper used to settle each retained command only after its own provider probe, at most 20 per 30-second sweep, so a box with 35 commands that Modal had already ended took 11 more minutes to clear while the session waited. The first probe that finds the exact current box missing now retires the whole box in one transaction: every command, open request, terminal and process holder is settled, the lease goes cold, and a turn waiting on the box is woken. Commands lost with their sandbox now tell the agent "`cmd` is no longer running because its sandbox was shut down or lost; whether it finished is unknown. Check its effects before running it again." instead of "result unavailable", and the session's Incoming panel shows several such results as one row with a single dismiss action.
- d6ea462: When a model provider is overloaded or unavailable, conversations now name the affected model and provider instead of reporting a generic "upstream dependency". While Opengeni retries the same turn, a live status above the composer reads, for example, "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock) — retrying (attempt 2 of 5)…". It replaces itself on each attempt and adds no timeline rows. If every retry fails, the turn ends with "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock). Opengeni retried 5 times without success. Try again in a few minutes, or switch to another model." The web app's failure banner keeps its Retry button and suggests the model picker. Recovery events gain the optional public fields `modelLabel`, `providerLabel`, `providerCondition` and `maxProviderRecoveryCount`. `@opengeni/react` exports `ProviderRecoveryNotice` and `currentProviderRecovery`, and `SessionConversation` shows the live status automatically. Retry pacing and the five-retry budget are unchanged.
- 5cb9c49: The collapsed queue chip in `SessionChrome` now shows the text of the latest queued message beside its Steer action, so a message sent while the agent is working is visible without opening the queue. That Steer now sends the message it shows (the latest) instead of the first in line. In the open queue list, every row keeps Steer visible; move, edit and delete still appear on hover.
- 588b90f: Preserve restored button and link focus when a composer becomes interactive after delayed draft hydration.
- 541a359: Keep the session-only conversation controller independent of the full provider and styled component graph.

  Preserve unavailable-chat feedback and custom labels when an older session proxy refuses new conversations.

- 2a19988: Buffer early ttyd terminal input until a supported sandbox's Bash Readline readiness signal. Keep old images explicitly legacy and offer a deliberate manual-input escape that clears buffered typing for startup prompts or unsupported shells. The guarantee requires the matching sandbox image; existing daemons are not restarted. Relay PTY behavior is unchanged.
- 8f02eb2: Links are now recognisable at rest. A new `og-link` utility gives text links a quiet resting underline tinted from the link's own colour, a full-ink underline on hover, and a focus outline, because the neutral grey palette cannot mark links by colour alone. Chat markdown links (web, artifact and sandbox file links), child-session links, usage-meter and viewer retry actions use it, and so do the web app's shared link primitives (`Button` link variant, help links, setting-row links, empty-state links) and inline text links across settings, capabilities, schedules and knowledge. The precompiled stylesheet ships the utility for hosts without Tailwind.
- 2fb5ec6: Record operator-retired child work as a visible, non-actionable parent timeline receipt, without waking the parent or creating pending execution input.
- b9ae380: A message that arrives while the session's sandbox is being replaced no longer sits behind a bare "Recovering". The live status above the composer now says "The sandbox reached its maximum lifetime, so Opengeni is moving the workspace to a fresh sandbox…" (or that the sandbox is being saved, recovered or moved, from the recorded transition) with "The turn continues automatically as soon as the sandbox is ready." It shows no retry counter, because this wait has no retry budget. `ProviderRecoveryFacts` gains an optional `sandboxWait` flag.
- 27287ee: Support an authenticated XLSX download action in the native spreadsheet editor, including embedded views, sync gating, progress, errors and cancellation.
- 615480c: A turn parked on a usage limit while a startup step is still running no longer shows a chevron that opens an empty fold. Running startup steps are hidden in the work row, so only failed or cancelled steps count as details to reveal.
- 2499dd2: A turn parked on a usage limit now reads "Usage limit reached" with the guidance "Try again after your quota resets, or switch to another model or provider." It no longer shows a running clock or promises that the work continues automatically. Waits that need a person (reconnect, disabled accounts, an ineligible pinned account) keep their recorded reason and are not labelled a limit; they also show no clock. A work row with nothing to reveal (for example a turn parked before any visible work) renders without a chevron and is not a disclosure control, and the wait guidance stays visible when the work is expanded. Approval and agent waits and the Working clock are unchanged. `TurnSummaryStatus` gains an optional `guidance` line and `TurnSummary` an optional `expandable` prop.
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
- Updated dependencies [2be7683]
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
  - @opengeni/artifact-tool@2.0.0
  - @opengeni/connect@2.0.0

## 1.4.4

### Patch Changes

- 6384dbd: Keep browser actions on the selected tab when earlier receipts arrive after a source, tab, controller or document change. Discard prior source state before paint and capture immutable controller fences. Preserve immediate input from completed receipts for the same page without extra accessibility requests. Prevent earlier action deliveries from replacing newer settled observations or failures while returning each operation's result to its caller. Fence selection observations and errors to their exact invocation so a selection round trip cannot revive an obsolete view. Order selection observations with refresh reads while preserving current action outcomes.

  Prevent older tab-open and tab-close results from replacing later selections. Reconcile their inventory after pending selections settle without replacing the selected page's observation.

- 6384dbd: Preserve the current Desktop selection and generation when an action receipt arrives after a view or source change. Discard previous source state before paint, while retaining current observations during same-source refreshes. Keep explicit focus behavior and fresh fences for immediate sequential input. Prevent earlier action deliveries and their refreshes from replacing newer settled observations or control failures while returning each operation's result to its caller. Fence selection observations and errors to their exact invocation so a selection round trip cannot revive an obsolete view. Order selection observations with refresh reads while preserving current action outcomes.
- 6384dbd: Negotiate native desktop click continuation so viewers send the first click immediately and submit the real second click while its HTTP receipt is pending. Require the exact completed first operation plus one-use native delivery proof, preserve painted-frame coordinates and geometry, and reject failed, unknown, expired or unrelated continuations without replay. Later viewer input waits for both outcomes; Linux physical input serializes without queuing independent background AT-SPI actions. Background native mutation admission fences click proof through completion, cancellation and panic so overlapping work cannot restore authority.

  Keep bounded original Window keyboard/clipboard identities across read-only refreshes, with live object, process, geometry and focus revalidation. Preflight whole key batches before input, and reject Window pointer points covered by another X11 client. Preserve uncertain outcomes after any possible input delivery.

- 1405691: `OpenGeniChat` / `SessionList`: Rename and Archive are visible on touch devices. They were hover-only, so phone and tablet users of an embedded chat could not rename or archive a chat.
- Updated dependencies [6384dbd]
  - @opengeni/sdk@1.4.4
  - @opengeni/connect@1.4.4

## 1.4.3

### Patch Changes

- Updated dependencies [c0c0f74]
  - @opengeni/sdk@1.4.3
  - @opengeni/connect@1.4.3

## 1.4.2

### Patch Changes

- b9bd35f: Every `@opengeni/react` entry is now marked `"use client"`, so a Next.js App Router Server Component (for example `app/page.tsx`) can render `<OpenGeniChat />` directly. Before, `next build` failed while prerendering with `TypeError: createContext is not a function`, and the host had to wrap the chat in its own client component.
  - @opengeni/connect@1.4.2
  - @opengeni/sdk@1.4.2

## 1.4.1

### Patch Changes

- 9145bad: Connector catalogs no longer offer connectors that cannot connect on the current deployment. Some providers refuse OAuth self-registration (Asana, HubSpot, Front, Box, Dropbox, Canva, Vercel, and others). When the deployment has no operator-registered OAuth client for such a provider, the catalog reports `runtime.operatorOAuthClient.configured: false` and connector discovery hides the row. Rows that are already connected stay visible.
- be95071: Live voice for embedded chats. `createSessionProxyHandler` now forwards the realtime model catalog and the live voice call routes (begin, connect, heartbeat, end, activate, transcript sync) as the resolved end user, with Opengeni's usual `sessions:control` and call-ownership checks; `beforeForwardMessage` sees voice start and transcript saves as `delivery: "realtime"`, and `realtimeVoice: false` turns it off. The stock `OpenGeniChat` composer shows the live voice button when the workspace offers an available voice model.
- 1f112d5: An expired or revoked server API key no longer shows end users a raw `OpenGeni API 401: authentication required` message. `OpenGeniChat` and `SessionConversation` in `baseUrl` mode now say "Chat is unavailable right now. Ask an administrator for help." (other load failures use the same brand-neutral copy as the rest of the UI), and the session proxy logs one server-side warning telling the developer to create a new key and update `OPENGENI_API_KEY`.
- 17bb58b: `useGoal` no longer refetches (and 404s) the goal on every turn and session event while the session has no goal; only goal events can create one.
- 0e45b19: `@opengeni/react/compiled.css` no longer triggers Vite's "Transforming this CSS nesting syntax is not supported" build warning. The markdown table's last-row rule now nests with a leading `&`, which bundlers flatten for their default browser targets.
- 6c69bb0: `@opengeni/react/compiled.css` no longer makes Next.js builds report "Compiled with warnings" (autoprefixer: `start value has mixed support`). The capability-setup label uses `align-items: flex-start`.
- 37c7278: The conversation timeline now listens for `scrollend` natively. React 18 has no `onScrollEnd` prop, so React 18 hosts logged "Unknown event handler property `onScrollEnd`" and never ran the handler that decides when a reader has scrolled away from the live tip.
- e852eb7: Voice input never deletes a real dictation on Cancel, Escape, or when live voice takes the microphone: anything longer than a few seconds stops and stays saved on the device to transcribe or discard explicitly, and an Escape already handled by a dialog or menu is ignored. A dictation left behind by a closed or crashed tab is offered again as soon as the app reopens instead of after the owner timeout. A transcript that was never inserted is offered plainly ("Insert it into your draft?") rather than as possibly duplicated. Dictation shows elapsed time and warns before the automatic stop. Saved/error explanations wrap instead of truncating, and on phones (including container-responsive embeds) they take the controls row while Pause, Stop, and Send stay. Fixed dictation failing after a remount (React StrictMode) because the recording store was reused after close. Live voice: a definitive failure before the first connection, including a blocked or missing microphone, ends the call and keeps an actionable reason visible next to the voice button until the user dismisses it or tries again (no "OpenGeni API 409" prefix or reference id); autostart makes one attempt instead of looping; the model menu says "Opengeni"; and a disabled start control names its blocker. `useVoiceInput` exposes `recordingStartedAt` and `maxRecordingSeconds`. A slow microphone prompt no longer fails live voice in a session that had an earlier call ("Realtime lease version changed"). The dictation start error is dismissible, live voice taking the microphone clears a stale one, and starting dictation retires a stale live-voice start failure, so the two never show side by side. Voice credit copy no longer says "out of credits" to an account holding only free chat credits.
- Updated dependencies [9145bad]
- Updated dependencies [be95071]
- Updated dependencies [1f112d5]
- Updated dependencies [784e862]
- Updated dependencies [f290348]
- Updated dependencies [e852eb7]
  - @opengeni/sdk@1.4.1
  - @opengeni/connect@1.4.1

## 1.4.0

### Minor Changes

- 5a0c6f3: Add configurable Azure GPT Live hosted voice through the existing realtime controller, preserving connected subscriptions and workspace providers. Persist timed transcript fragments across connection rotation and graceful stop.
- e0ccba8: Goal controls and sub-agent chats in the stock embedded chat.

  - `createSessionProxyHandler` serves the session goal: `GET goal`, `PATCH goal` forwarding only `{ status: "paused" | "active" }` (a browser rationale is dropped; other fields are refused), and `DELETE goal`, the proxy's only `DELETE` route.
  - `SessionConversation` shows the goal in its chrome with Pause, Resume, and Clear when the client can reach goals. An older proxy's 404 reads as "no goal".
  - `SessionConversation` takes `onOpenSession`, forwarded to the timeline's sub-agent cards and the chrome's child updates. `OpenGeniChat` defaults it to opening the child chat in place.

- 8e11301: Make the stock `OpenGeniChat` work end to end behind `createSessionProxyHandler`.

  - Generated images and video, published files, and browser or computer screenshots now display in an embedded chat. Under `files` the proxy forwards a session's screenshot reads and the workspace artifact content (with `Range`) and video playback-source routes, and only for an artifact the API proves that session produced. `SessionConversation` supplies the loaders by default; `createWorkspaceRetainedArtifactLoader`, `createSessionRetainedScreenshotLoader`, and `createWorkspaceRetainedVideoLoader` are exported for custom timelines.
  - The proxy's client config reports `artifacts: false` (unless `artifacts: true`), `sessionCreation`, and `archive`. Site previews show as unavailable without a request, and "New chat" and "Archive" are hidden when the proxy cannot serve them. A refused create from an older proxy shows the "New chats are not enabled" label.
  - The composer microphone appears in `SessionConversation` and the new-chat composer when the deployment reports voice input available; `voiceInput={false}` opts out.
  - The API's CORS policy allows the `X-OpenGeni-Session-Id` scope header, so a cross-origin browser client's conversation media and Site reads are not refused at preflight.

- ef0f1c8: Metered voice input: add the `azure-mai` voice-input provider id and the `insufficient_credits`, `allowance_exhausted`, and `monthly_model_cost_limit` transcription error codes, which resumable recordings now also report as their `errorCode`. The composer transcription control adds `errorInsufficientCredits`, `errorAllowanceExhausted`, and `errorPolicyBlocked` messages; a caller whose payer cannot be verified now sees a policy refusal instead of a microphone-permission error.
- e01662a: Deployment-funded live voice is credit-gated and billed per started minute. Heartbeats can return a `stop` instruction, the realtime controller ends the call gracefully and exposes `refusal` (`insufficient_credits`, `allowance_exhausted`, `monthly_model_cost_limit`, `realtime_voice_unavailable`), and catalog items carry `unavailableCode`. The voice control shows an out-of-credits state instead of a generic error.

### Patch Changes

- bd9521c: Approval reviews read as one action: multi-item work no longer shows "batch" in titles, a Block reports its own reason and a `blocked` status, and an older request whose saved arguments cannot be recovered still offers Decline so the session never stays stuck.
- 3bd1060: Add a read-only capability access review and version-fenced root-to-child application helper so the web connection card can explicitly approve parent tool additions before selecting integration tools in a child chat. Preserve existing choices and child policy ceilings, and avoid adding mandatory runtime servers to explicit selections.

  Preserve optional/eager connector flags when retaining workspace defaults, and keep setup owners valid across StrictMode replay while retiring work from changed access scopes.

- 12f84ed: Loading older session history no longer tears down and reopens the live event stream. Rows that arrive while an older page is in flight append once, in order, onto the prepended window, and the connection state stays `live` (no "Connecting…" flash or repeated session reconciliation on every scroll-up). The stream still closes when a full backward page evicts the live tail and the timeline enters history mode.
- 8e90088: The dark theme's composer focus glow is now the intended faint halo (10% of the accent) instead of a full-strength 24px glow, which showed as a strong grey haze on dark hosts.
- Updated dependencies [5a0c6f3]
- Updated dependencies [e0ccba8]
- Updated dependencies [8e11301]
- Updated dependencies [ef0f1c8]
- Updated dependencies [e01662a]
  - @opengeni/sdk@1.4.0
  - @opengeni/connect@1.4.0

## 1.3.0

### Minor Changes

- 178b5ae: Unify connector Allow, Ask first and Block decisions across tool transports and settings. Add durable programmatic approval handles, exact stored-operation continuation, and shared review facts with portable React presentation and paginated protected details.

  Add lightweight Gmail message selection and bounded pagination/chunk helpers. Preserve exact access checks, uncertain outcomes and existing client compatibility. Deploy matching API, worker and native runtime artifacts through the documented maintenance migration.

### Patch Changes

- 2aed1a1: Embedded chat fixes for proxied embeds:

  - `OpenGeniChat`'s new-chat composer is now the follow-up composer: file attachments, the model picker when offered, and `conversationProps.composerProps` (custom controls, voice input, copy). The first message's files and explicit model choice reach `createSession`, whose hook input now carries `resources` and, unless `modelSelection: false`, `model`, `reasoningEffort`, and `latencyMode`; the proxy adds those files and applies those choices to the request the hook returns.
  - The session proxy forwards voice input (`POST .../transcriptions`) as the resolved user, and reports only one-shot recordings in the client config. `voiceInput: false` reports voice unavailable and refuses the route. Previously the config advertised voice while the route returned 404.
  - `OpenGeniChat` and `SessionConversation` in `baseUrl` mode accept `headers` (static or per request) and `fetch` for bearer-token apps, and use a `client` passed alongside `baseUrl` instead of silently dropping it.

- Updated dependencies [178b5ae]
- Updated dependencies [2aed1a1]
- Updated dependencies [414d416]
  - @opengeni/sdk@1.3.0
  - @opengeni/connect@1.3.0

## 1.2.0

### Minor Changes

- d870f32: Support model-scoped signup and coupon credits with a shared operator default and
  per-offer overrides. Update coverage at runtime, spend eligible promotions before
  general credits, and preserve allocation and retry accounting. Keep scoped coupon
  redemption separate from paid top-ups. Show credit funding in model selection and
  current coverage on demand in billing. Legacy unrestricted grants stay unrestricted.

### Patch Changes

- e70ddfe: Refresh model funding when the embedded conversation's model picker opens, so
  credit labels reflect current balances and promotional coverage without closing
  the menu or adding labels to the closed selector.
- 21c8904: Support optional HTTPS model catalog logos with safe image fallbacks, and declare the item type of the SDK filesystem function tool's command tuple.
- d081155: Keep accepted startup feedback in the conversation with continuous loading presentation and immediate dispatch diagnostics. Show loading details after 30 seconds and slower-start copy after 60 seconds.
- Updated dependencies [11c4d3c]
- Updated dependencies [21c8904]
- Updated dependencies [d870f32]
  - @opengeni/sdk@1.2.0
  - @opengeni/connect@1.2.0

## 1.1.0

### Patch Changes

- c600e3a: Use the full scoped model catalog for goal continuation and validate goal Resume before changing state. Preserve specific admission pause reasons and show the actionable rationale in the existing goal controls.
- Updated dependencies [411b3b5]
- Updated dependencies [4d5053f]
- Updated dependencies [208dec1]
  - @opengeni/sdk@1.1.0
  - @opengeni/connect@1.1.0

## 1.0.2

### Patch Changes

- 43da85e: Write the product name as "Opengeni" in user-visible messages. Code identifiers, the `OpenGeni API <status>:` error prefix, and protocol values are unchanged.
- ba5a639: Fix a dark composer on light pages: stock theme tokens rewritten by the host's CSS minifier (for example Next.js turning `#333333` into `#333`) are no longer mistaken for host customizations.
- d4ada81: Expanding a live turn's work row now reads like a finished turn: its progress notes are listed in order between the steps, and the copies above the row fold away in one short motion while the row rises into the first note's place (or the top edge) with its list beginning just beneath. Closing reverses it. Nothing else on screen jumps: the reader's position is held through the moment the page is briefly shorter, and closing from the sticky header lands back on the closed row.
- cbe4357: Simple embedding path. An organization API key acting as a user (`asUser`) on a
  shared workspace of its own organization now adds that user's missing membership
  once, with conversation permissions, when the key holds `members:manage` plus
  those permissions; existing memberships are never changed. The `@opengeni/sdk/chat`
  `OpenGeni` facade derives `organizationId` from the key, maps `{ user, tenant }`,
  `{ user }` (one workspace per user), or `{ user, workspaceId }` to a workspace
  created on first use, and `og.workspaceId({ tenant } | { user } | { workspaceId })`
  translates your ids. The session proxy reports its resolved workspace in client
  config, so `<OpenGeniChat baseUrl="/api/opengeni" />` and
  `<SessionConversation baseUrl="/api/opengeni" sessionId={id} />` need no provider
  or workspace id. Explicit membership APIs and provider-based usage are unchanged.
- Updated dependencies [43da85e]
- Updated dependencies [4476ca7]
- Updated dependencies [cbe4357]
  - @opengeni/sdk@1.0.1
  - @opengeni/connect@1.0.1

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

### Patch Changes

- Back to your message now floats 12px below the top of the conversation, and drops just below an expanded work-header strip only while that strip is pinned to the top, instead of always sitting below where the strip would be.

## 7.8.1

### Patch Changes

- Updated dependencies [627ff68]
  - @opengeni/sdk@7.8.1

## 7.8.0

### Minor Changes

- 692a1f5: Show models by their clean display name and maker logo outside model settings. Add `modelDisplayName`/`modelVendor` (`@opengeni/sdk/model-display`) and `ModelName`/`ModelMark` (`@opengeni/react`). Picker rows, triggers, queue rows and fleet tiles no longer show routing ids, and organization- and workspace-connected copies of one model share one "API keys" group and render identically.
- 395becb: Make the embedded chat look native inside host products. `OpenGeniChat` and `SessionConversation` now follow the host page's light/dark theme (an enclosing `data-og-theme`, `class="dark"`/`data-theme` on `<html>`/`<body>`, the host `color-scheme`, then the page background) instead of defaulting to dark, and derive their backgrounds and cards from the host background (`surface="host"`; `surface="theme"` and customized `--og-color-*` tokens are kept). Their composer shows a Stop control only while a response runs instead of the workstream Pause control, and the next message continues a stopped conversation (`composerProps.runControl` opts back into `"pause"`); `ChatComposer` gains `runControl`/`running` and the composer subpath exports `StopButton`. The model picker is hidden in these embeds unless `modelPicker` is set or the proxy reports `createSessionProxyHandler({ modelSelection: true })`. In these embeds a yes/no question renders as two buttons without "Other" (`HumanInputForm`/`HumanInputSurface` `decisionButtons`), the live "waiting on you" divider no longer repeats the turn's waiting header, the "Back to your message" pill stays inside the timeline and hides in short viewports, a failed load offers Try again (`labels` localizes it), the new-chat state has a heading, and with `compiled.css` host global list/paragraph/heading styles no longer leak into SDK markup. `MessageTimeline` gains `questionNavMinViewportHeight`.

### Patch Changes

- f893cb5: Preserve annotation review scrolling and focus across parent and layout updates by consuming each requested note focus once.
- 92e4045: Add accessible Back and Forward controls to the Browser address bar using the existing target and document fenced history actions. Disable them while navigation is pending or no tab is selected, refuse observations from a previously selected tab, and retain existing address draft, focus, and failure handling.
- af57cf9: Use canonical ComputerSession frames and actions for screen and window viewers. Preserve the painted frame fence, reflect authorized human input availability, and enforce human sandbox input policy on each action while retaining separate agent tool authority. Older controllers keep frame viewing behind an encrypted proxy without receiving RFB input grants.

  App-only viewers require an explicit current input posture before enabling mutations. Refresh rechecks permission without starting a stream or native action, and physical machine screen-control consent remains separate from viewing.

- 8ce490f: Support multiple Claude subscription accounts with shared workspace, organization and owning-user account controls, verified browser sign-in profiles, usage windows, exact credential leases and quota-aware rotation. Preserve accepted work during capacity waits and recovery. Upgrade existing encrypted subscription credentials through the documented maintenance migration before starting matching runtime binaries.
- 424f44d: Make the conversation's floating navigation compact. Jump to latest and Back to your message are now identical small round arrow buttons at fixed, centered spots: the down arrow just above the bottom of the conversation and the up arrow just below the top. Their labels remain available to assistive technology and as tooltips, and touch screens get a larger invisible tap area instead of a larger button.
- e518530: Keep Desktop menus inside the viewer, make long lists scroll, and close viewer menus with Escape, an outside pointer, or focus moving out. Return focus to the menu trigger after keyboard choices without taking focus from pointer actions.
- 49fc1c0: `SessionCapabilityFrame` accepts optional `details` content inside the card and an `actionUnavailable` explanation that replaces the action when the viewer cannot start setup.
- b96f26e: Show an active goal as Waiting while other session work runs, with an explanation that the goal continues automatically after that work finishes.
- 3caca71: Jump to latest no longer shows while the reader is already at the bottom. Using a control in the conversation (Copy, a connection card) hands the view to the reader; the pill now appears only once something lands below them.
- 3cc26b5: Identify the default pinned HTTP client with a User-Agent, preserve caller overrides, and show retryable MCP sign-in discovery failures in connection setup.
- fe1739f: Use neutral model-group labels and icons in the stock embedded picker, while keeping explicit host branding and external-provider identities. Expose appearance-only picker customization on the complete conversation and preserve explicit first-party console branding.
- 978981a: Present expected sandbox lifecycle waits during model preparation as waiting rather than failed. Retain technical failure receipts and keep actual model and provider failures visible.
- 272c016: Expose command readiness separately from edit permission. Pause presentation mutations while earlier changes await settlement, preserving drafts, slide navigation, and zoom.
- 97d4f07: Require an explicit server-enforced screen grant for managed ComputerSession RFB input. Preserve viewing with pixel-only grants, recheck controller and target authority before forwarding packets, and use canonical frames and actions with older controllers. Desktop viewers default old attachments to view only.
- bb52f56: Open the whole desktop by default, show a screen selector for multiple displays, and move app/window views into the Advanced menu. Preserve explicit target choices and existing input authority across refreshes.
- Updated dependencies [af57cf9]
- Updated dependencies [8ce490f]
- Updated dependencies [692a1f5]
- Updated dependencies [395becb]
- Updated dependencies [3395acc]
- Updated dependencies [00000d7]
- Updated dependencies [746464c]
- Updated dependencies [272c016]
- Updated dependencies [6cdc0aa]
- Updated dependencies [0fba21e]
- Updated dependencies [97d4f07]
- Updated dependencies [1826595]
- Updated dependencies [b4d1c5b]
- Updated dependencies [14e95e9]
  - @opengeni/sdk@7.8.0

## 7.7.0

### Minor Changes

- 351cd79: Add `includePinned: false` to session-page reads so callers loading the pinned section separately can skip repeated pin hydration. The default response and ordinary-page pin exclusion are unchanged.

  Bound the browser event working set to 16 MiB or 20,000 events, with durable history accessible through existing navigation. Avoid copying the event window when no additional question evidence is needed.

### Patch Changes

- 9f0f7d3: Anchor the conversation's floating navigation in one stable place. Jump to latest and Back to your message now stack centered at the bottom of the timeline, with the later-activity status above them, instead of measuring the rows beneath them and sliding sideways or dropping below toolbars as content streamed or the host resized. The pills no longer wander on narrow, embedded, or mobile layouts, and both keep a 44px touch target on coarse pointers.
- 45e1b4f: Advertise background window input separately from background semantic controls. The CUA pilot viewer accepts targeted clicks and typing without offering unsupported foreground focus; existing native backends retain their focus guard.
- b786e5c: Keep failed or unconfirmed browser input visible while live frames continue. An explicit fresh check of the same browser clears the notice without replaying input.
- f336d3e: Show a pending approval once: readable turns no longer repeat the live "Approval needed" banner when the turn header already says "Waiting for you". `ApprovalSurface` lists flat arguments as labeled fields with an "exact arguments" toggle (nested arguments stay JSON), and the composer no longer shows a default keyboard hint (shortcuts stay in the send button title).
- 110bcb7: Fit computer frames to the dock, including small window captures, while preserving aspect ratio, capture resolution, and pointer coordinates. Refit on dock and frame size changes without measuring every incoming frame.
- 76ff363: Support workspace OpenAI and Azure OpenAI API keys with provider verification, isolated encrypted credentials, and externally billed model selection. Add the optional model verification flag to connection creation and preserve shell cancellation on macOS local sandboxes.
- c7be92c: Keep desktop IME candidate text and selection keys local until the person commits the text, then send that text once.
- 065316d: Keep desktop controls unavailable after a control service failure even while frames continue arriving. Reconnect refreshes the same desktop's control and media channels. App inspection failures, target refusals, and uncertain input outcomes remain separate from service outages.
- 946f6c3: Keep OAuth completion polling active when browser isolation detaches the provider window, and discover authentication for custom MCP connection setup from the live endpoint. Resolve tool-permission discovery for selectors with a single matching account, refusing ambiguous account choices.
- 5dacdd7: Add brand-neutral SDK error presentation and a shared native React host error-copy override, preserving diagnostic errors and delivery/retry state.

  Keep NewChat's full-height composer contained when using shipped CSS without a host reset.

- 8a5f977: Show named desktop actions and editable values in App controls. Structural accessibility nodes no longer crowd out usable controls, and the control count matches the available actions.
- cbb3e36: A send that names a model no longer in the live catalog now returns its 422 with `details: { code: "model_unavailable", modelId }` (the status, code and message are unchanged). `@opengeni/react` maps it to plain composer copy, offers Edit message instead of a Retry that cannot succeed, and exports `COMPOSER_MODEL_UNAVAILABLE_MESSAGE` and `isModelUnavailableSubmissionError`.
- Updated dependencies [7798558]
- Updated dependencies [45e1b4f]
- Updated dependencies [351cd79]
- Updated dependencies [da4ba6f]
- Updated dependencies [56584f9]
- Updated dependencies [31e3771]
- Updated dependencies [76ff363]
- Updated dependencies [d2fe11d]
- Updated dependencies [946f6c3]
- Updated dependencies [5dacdd7]
- Updated dependencies [479ec20]
- Updated dependencies [351cd79]
- Updated dependencies [70af8bb]
  - @opengeni/sdk@7.7.0
  - @opengeni/connect@0.3.2

## 7.6.1

### Patch Changes

- d03b4a8: Clarify that window app controls work in the background and label explicit foreground activation as “Bring to front”.
- cf1570d: Keep desktop images usable in narrow panels by placing app controls below the image. Wider viewers retain their side panel. Keep the foreground activation button readable within the image bounds.
- 09a991f: Hide Jump to latest when readers scroll back to the live bottom after returning to their question, preserving scroll intent across renders and releasing stale question focus.
- Updated dependencies [3f7ff5b]
  - @opengeni/sdk@7.6.1

## 7.6.0

### Patch Changes

- 9b3c40e: Show factual response-waiting copy once a model request is dispatched, while preserving the loading indicator and host customization.
- a1a23d2: Recover raw PostgreSQL rollback failures during turn startup using the existing exact-attempt recovery boundary. Present database failures without raw SQL or parameters, including historical failure events.
- Updated dependencies [e5b0123]
  - @opengeni/sdk@7.6.0

## 7.5.0

### Minor Changes

- b45621d: Artifacts and Sites now work inside an embedding product with the same components the OpenGeni console uses. `@opengeni/react/artifacts` gains the console's inline Site/HTML preview (`ChatInteractiveBlock`, `ArtifactSandbox`, `DeferredChatMedia`), `SiteView`, `EditableArtifactView`, and a host-mountable `SessionArtifactViewer`; `SessionConversation` renders `opengeni-site` fences inline and opens agent artifact links through `onOpenArtifact` (`viewerLinkResolver` for a custom timeline). `createSessionProxyHandler({ artifacts: true })` serves only the artifacts OpenGeni lists for the requesting session (read, editor live ticket, Site detail and sandboxed HTML), and client config advertises the live socket URL and browser cache partition. The SDK client adds `withHeaders`, `apiUrl`, and `fetchApi` for host-authenticated transports. Every built-in artifact string is translatable through a `labels` prop (partial `ArtifactLabels`) on `SessionArtifactViewer` and `ChatInteractiveBlock`, or `ArtifactLabelsProvider`. Document and presentation editors compose one projection at a time, so opening an artifact with a long history no longer floods the artifact Worker's request queue.
- 709eef2: Usage allowance UI. `@opengeni/react/usage` adds `useUsage`, `UsageMeter`,
  `UsageLimitNotice` (the calm near/at-limit composer line) and
  `UsageMemberList` (an admin roster with a share-of-budget slider that shows
  oversubscription as allowed). The conversation renders an allowance refusal as
  a structured "usage limit reached" row that hosts reword with
  `allowanceExhaustedLabels` or replace with `renderAllowanceExhausted`, and a
  queued prompt refused before it starts stays above that row.
  `@opengeni/sdk/usage-allowances` exposes allowance reads and administration as
  free functions over `requestJson` for browser code without the root client.

### Patch Changes

- c85f432: Show failed-send reasons inline rather than hiding them in a tooltip. Credit and usage-allowance refusals no longer offer an unchanged Retry; Edit message restores a definitively refused prompt and its attachments into an empty composer while preserving the current model selection. Transient and uncertain deliveries keep their existing retry and reconciliation behavior.
- 2253be0: Clarify that browser diagnostic counts include earlier pages in the same tab. Show unavailable counts until an observation exists, preserving observed zero counts.
- c9c59b5: Explain when a chat's browser was lost or failed instead of silently showing an empty viewer.
- 726f09d: Respect the desktop backend's mouse and keyboard availability. Encoded-frame views allow supported input independently; RFB views require both capabilities for direct control. Keep screenshots visible and show a view-only notice when direct input is unavailable.
- 28c2b3f: Show Latest question only after the chat's initial history is ready, so startup cannot silently cancel that navigation.
- 5ba250d: Offer Add note for text selected while the timeline's annotation controls are still loading.
- 45d1301: Expose repeated empty final replies as a typed, informational completed-turn notice without failing goals or deferring later updates.
- b45621d: Fix embedded artifact viewing for external users by resolving fresh effective workspace grants, checking exact session associations on every request, and binding live editor tickets to their source session. Keep editor authority and reconnect reads current when clients or sessions change, and allow retrying temporary viewer configuration failures.

  Source-bound editor sockets renew a 15-second lease through the host proxy, rechecking product authorization; existing unbound console sockets are unchanged. Compact authenticated source tickets remain within the existing wire limit.

  Add server-only `@opengeni/sdk/session-proxy` helpers. Stream embedded Site HTML with backpressure and cancellation and enforce a 25 MiB actual-byte ceiling; oversized streams fail with `site_html_too_large`. Preserve the console's existing shared artifact components and list behavior.

  Allow PostgreSQL test fixtures to use an explicitly configured native server while preserving restricted-role and FORCE-RLS verification.

- d60f96a: Preserve history reading position when Markdown tables are remeasured during host rerenders or tail streaming, without changing table overflow, copy controls or viewport resizing.
- 0bbe2e7: Keep all React root exports available without requiring optional workbench peers at build time. Add terminal, editor, and desktop opt-in loader subpaths; hosts mounting those surfaces enable the installed peers once, with optional grammar and WebGL loaders supplied by the host.
- 45d1301: Load client-config model defaults for the exact workspace requested by the workspace model catalog hook.
- 0bbe2e7: `@opengeni/react/session-ui` exports `OpenGeniProvider` and the tool-renderer
  registry (`createDefaultToolRegistry`, `createToolRegistry`,
  `defaultToolRegistry`), so a host can render `OpenGeniChat` or
  `SessionConversation` from that entry alone without the root's optional
  workbench peers.
- 5f7aa12: The conversation's floating "Jump to latest" and "Latest question" pills slide sideways when their resting spot would cover a control, such as the active turn's "Working" row or an inline Site card's toolbar. Only the pill moves; the timeline's scroll geometry is unchanged.
- 5b48f00: Add recoverable allowance lifecycle state and idempotent clear receipts.
  Preserve typed allowance scope and reset details in web, MCP, and Slack
  refusals with administrator-specific remedies.
  Expose browser-safe refusal helpers through `@opengeni/sdk/allowance-refusal`
  without widening React's runtime dependency boundary.

  Recheck allowance after paid compaction and align continuation admission with
  its frozen causal lineage. Keep allowance storage compatible with rolling
  deployment, preserve settled usage across period edits, harden definer search
  paths, and order organization locks before tenancy fences.

- 5b48f00: Default missing webhook lanes only after signature verification, preserve the
  public organization webhook event vocabulary while rejecting usage subscriptions,
  and keep allowance refusal presentation schema-runtime-free for browsers and
  React Native. Emit the focused integration and refusal entries in published builds.

  Fence the next model dispatch on settled usage and frozen-human admission, refuse
  fresh delegated work before interruption, and repair workspace-less Knowledge
  indexing and historical migration fixture dependencies.

- Updated dependencies [a6ff780]
- Updated dependencies [0bbe2e7]
- Updated dependencies [d9ec660]
- Updated dependencies [45d1301]
- Updated dependencies [fd5fb34]
- Updated dependencies [b45621d]
- Updated dependencies [b45621d]
- Updated dependencies [45d1301]
- Updated dependencies [f874217]
- Updated dependencies [b45621d]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [3545ca3]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [b45621d]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
- Updated dependencies [709eef2]
- Updated dependencies [5b48f00]
- Updated dependencies [0bbe2e7]
  - @opengeni/sdk@7.5.0
  - @opengeni/connect@0.3.1

## 7.4.0

### Minor Changes

- 9a4a45c: Make long turns read like a coding agent in the compact progress presentation (`turnSummary={{ rolling: true }}`). Assistant commentary joins its activity cluster (a phase-less message of the running turn stays the live note until its turn ends or it outgrows a note), and each exchange folds behind one status row ("Working · 2m 14s · 12 steps" with the latest progress note and current step, or "Waiting for 2 agents · 3m") with the answer below a "Worked for …" separator. Routine machine inputs, recorded waits, and compaction fold inside the exchange; failures, approvals, auth recovery, human input, scheduled prompts, and images stay visible. Following the tip stops once an answer pushes its question to the top, and a "Your question" control returns to the question being read. Recorded waits now say "Waited for 1 agent · 3m 5s" instead of "Wait recorded".

  New API: `groupTimeline(items, { foldExchanges: true })`, `TurnSummary`'s `status` prop, optional `waitingAgents` / `waitEndedAt` on recorded wait notices, and optional `startedAt` (when a streamed message began) on `AgentMessageItem`. `ActivityItem` now includes `AgentMessageItem` for folded commentary; exhaustive switches over activity kinds need an `agent-message` case.

- a6644b6: Framework adapters for web-standard handlers such as
  `createSessionProxyHandler` and `createChatHandler`: `@opengeni/sdk/next`
  (`toNextRouteHandlers`, `createSessionProxyRoute` for an App Router catch-all
  route), `@opengeni/sdk/express` (`toNodeMiddleware` for Express, Connect, and
  `node:http`, streaming SSE and aborting on disconnect), and
  `@opengeni/sdk/hono` (`toHonoHandler`).

  The session proxy serves the chat list (`listSessionPage`, limited by default
  to the chats the resolved user created; `sessionList: "visible" | false`) and
  archive/restore (`archive: false` to disable). `@opengeni/react` adds
  `SessionList` and `OpenGeniChat`, a list-plus-conversation experience with a
  responsive sidebar/drawer, a new-chat composer, and rename/archive.

- a6644b6: `OpenGeniProvider` no longer blocks or reloads the page when the server's API
  contract revision differs from the bundle's; that stale-tab protection is now
  the opt-in `reloadOnApiContractChange` prop used by the stock OpenGeni console,
  so an OpenGeni deploy never reloads an embedding product's page. The session
  proxy reports its own SDK contract revision in `/v1/config/client` and never
  forwards the upstream `x-opengeni-api-contract` header to the browser.
- d480872: Agent links to OpenGeni objects now work inside an embedding product. `artifact:` files download by default from `SessionConversation`; sandbox-path downloads require explicit proxy `sandboxFiles: true` and use bounded, no-symlink reads within the session working directory. Editable artifacts and Sites route through a new `resolveLink` prop (`MessageTimeline`, `SessionConversation`, `Markdown`, `OpenGeniLinkProvider`) instead of rendering console paths that 404 on the host origin. Invalid reserved references render unavailable. `parseOpenGeniLink` in `@opengeni/sdk` classifies the same hrefs for non-React clients and preserves validated console return hints. Editable-artifact export uses configured exporter capabilities and preflights the exact format and options before creating a snapshot or pinning a version. Stock deployments serve spreadsheet XLSX; the artifact Skills stop promising unsupported PDF/DOCX/PPTX exports.
- a6644b6: `@opengeni/react` no longer names the optional `@pierre/diffs` peer in any
  `import()` reachable from the conversation, so a Next.js (Turbopack) or Vite
  host that imports only `OpenGeniProvider` and `SessionConversation` builds
  without it. Hosts that install `@pierre/diffs` opt in once with
  `enablePierreDiffs()` from the new `@opengeni/react/diffs` entry (or
  `registerPierreDiffs(loader)`); otherwise diffs and file views are plain text.
  `SessionConversation` hides its model picker when the client config reports
  `modelSelection: false`, with a `modelPicker` prop to override.

  `createSessionProxyHandler` adds `beforeForwardMessage`, which returns
  server-owned `modelContext` and MCP credential rotations
  (`mcpCredentialUpdates`) for every forwarded message, steer, composer submit,
  and browser-started create, or a `Response` to refuse it. With
  `modelSelection: false` the proxy reports it in the client config.
  `ClientConfig` gains the optional `modelSelection` field.

- a6644b6: `SessionConversation` now renders pending tool approvals with Approve/Reject
  actions, wires composer file attachments into sent messages when the
  deployment enables file uploads (opt out with `attachments={false}`), and
  accepts a `toolRegistry` for product-specific tool-call rendering.

### Patch Changes

- d00a203: Keep every answer visible in the compact progress presentation (`turnSummary={{ rolling: true }}`). An answer was folded into the "Worked for …" row, and shown only as a muted two-line preview, as soon as another machine-triggered turn followed it in the same exchange (an agent message, child result, wait timeout, goal continuation, background command result, or steer instruction). Now only work folds: the later turns fold into a new row below the answer, which opens as soon as the input is delivered, and their own answers render below that row. A reader stopped at an answer stays in place while that later work runs.
- 378327b: Emit one `agent.message.completed` per assistant message with its `phase` and, when the provider sent one, its `messageId`. Runtime normalization read a text field that Agents SDK message items do not have, so no per-message completion or phase ever reached events. Deltas now carry the phase a Responses provider declares, also through compact delta coalescing. An undeclared message gets the SDK's own rule: `commentary` when the same response asks for client tool work (including a client tool search) or ends with a later message, `final_answer` for the message the SDK returns. A Responses message completes as soon as it finishes, before the next message streams, instead of after the whole response. The worker skips the phase-less settlement copy once the stream completed the final text.

  Commentary is activity: it no longer marks a session unread (rolling migration 0527 indexes the new attention predicate), wakes `session_wait` change mode, becomes a Slack post, or enters the SDK chat reply. A turn that settles with only commentary still replies with its latest note. When a human or API message's turn ends waiting for input (`wait_for_input`), settlement records its latest assistant message on `turn.completed` as `reply` (the output stays empty; a child an agent spawned and a scheduled, automation or maintenance session's first turn record none), so a status answer given before waiting again marks the session unread and becomes a Slack post with the requester mention while delivery stays open for the result; stored history keeps the provider's phase. The SDK chat fold completes each segment by `messageId`, so a note completed after its answer streamed never repeats the answer. The MCP conversation view labels commentary, `latest: "terminal"` skips it, and the React timeline knows a streaming note is commentary from its first delta. `phase` stays optional.

  Older SDK clients see the new completions too: their live reply now separates a note from the answer that follows it in the same response with a blank line (it was run together before), and `history()` lists each completed note as its own assistant message. Roll the API before the workers: an older API process next to a newer worker can briefly post notes to Slack, wake `session_wait` change mode on them, and mark sessions unread for them.

- 1503ad7: Report unavailable browser controls even while cached or live frames remain visible, and disable keyboard capture until control recovers.
- 4f6d83a: Keep browser diagnostics opaque and confined to the page viewport, below tabs,
  address controls, and human handoff banners. Correct missing browser and desktop
  surface/text color utilities in both themes, and keep drawer actions usable in
  narrow docks.
- 7a3d134: Keep browser profile and launch menus within narrow viewer panels, with scrollable
  content. Dismiss browser menus on outside pointer input or Escape without closing
  the expanded workspace underneath.
- 01f50bf: Mark the composer send and pause buttons and the queued-prompt Steer buttons
  with a stable `data-analytics-action` attribute (`send`, `pause`, `steer`) that
  a host's product analytics can read. The attribute is inert, and a host can
  override it on `SendButton` and `PauseButton` through their props.
- 0aa60a6: Keep a failed optional Files module inside its workspace tab with an explicit
  reload action instead of replacing the conversation and composer with a route error.
- 4b39032: Load the optional workspace Files renderer asynchronously when first mounted, keeping chat and workspace
  state mounted while its renderer loads. Preserve file capability checks and the
  existing visited-tab lifetime.
- 454476c: Fence retained history-navigation callbacks and pending page reads to their owning
  session, workspace, client, and replay lifetime. Stale navigation cannot stop a
  replacement session's live feed, replace its history, or leave loading stuck.
- 4b39032: Expose successful initial history readiness independently of loading and stream
  errors, including empty histories. Clear stale initial-load errors on fenced retry
  and successful window recovery without letting old sessions overwrite new state.
- 4b39032: Give queued Latest question callbacks a current-navigation guard so a delayed
  refresh cannot reopen the queue after another history jump. Reuse canonical
  execution evidence when locating queued prompts whose ledger lacks turn.started,
  including tools, startup, recovery, and capacity events.
- 4b39032: Load the optional Latest question resolver on demand while preserving queued
  destinations, bounded history, retryable lookup errors, and navigation guards
  across the module-loading delay.
- a6644b6: Diff and file views already on screen upgrade to highlighted rendering when a
  host registers `@pierre/diffs` later, so hosts can call `enablePierreDiffs()`
  from the lazily loaded route that renders diffs instead of at startup. The
  OpenGeni console now does this, keeping the peer and its highlighter out of
  the initial bundle.
- dcb578d: Keep legacy timeline work without turn IDs aligned with approval, terminal status, and subsequent-work boundaries instead of leaving stale Working indicators.
- b591ea1: Support native Claude Messages with separate encrypted Anthropic API-key and Claude subscription setup-token connections, workspace access policies, streaming tools and thinking, prompt caching and usage accounting. Add connection UI and payment-source labels. Migration 0544 expands organization connection kinds and lifecycle validation.

  Pin the Claude subscription client identity headers, persist account/device metadata with encrypted credentials, and add request-scoped attribution. Existing token-only connections require replacement with identity metadata. The captured billing checksum remains unverified and is not replayed.

  Preserve Claude session identity across worker turns and recovery while keeping prompt lineage scoped to each run.

  Admit organization Claude models through session creation and lock their correct connection kind. Preserve Claude provider labels in the client catalog. Project initial system/developer instructions into Anthropic’s top-level system field so full agent sessions with skill instructions execute successfully.

  Polish Claude setup with local settings import, full-page token renewal, named model choices, provider marks, accurate subscription payment labels, and workspace discovery of organization-owned connections.

  Support workspace-owned Claude credentials, model generations, access controls and setup/account screens alongside organization connections. Migration 0545 expands workspace custom-model provider kinds. Gate Claude subscriptions behind OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED (default off), leaving Anthropic API keys and other providers unchanged.

- cabfc5e: Adopt the neutral theme: a shared `hover` token, unified menu and popover
  styling across the composer, model picker, realtime control and file browser,
  refreshed terminal colors, and "Opengeni" in user-visible copy.
- a1b6b8e: An automatically attached (optional) repository that loses access after a task started no longer fails the task's later turns. Before the strict per-turn GitHub App allowlist recheck and installation-token mint, the worker drops, for that turn only, each optional repository the workspace allowlist no longer admits or the GitHub App installation can no longer reach, and reports it as `skippedOptionalRepositories` on a `sandbox.operation.completed` event named `optional-repository-access`. It only ever removes repositories; explicitly attached repositories keep the strict behavior.

  Optional repository clones are also bounded (60 seconds each, 90 seconds together) when the sandbox has a `timeout` binary, so a hung fetch is skipped with the usual warning instead of failing sandbox setup. Explicit clones are unchanged.

  `@opengeni/github` adds `findInaccessibleGitHubAppInstallationRepositories`. `@opengeni/runtime` exports `OPTIONAL_REPOSITORY_CLONE_TIMEOUT_SECONDS`, and `repositoryCloneCommand` and `runRepositoryCloneHook` accept an optional per-repository timeout.

  `@opengeni/react` keeps the `optional-repository-access` report out of the transcript, like the routine repository-clone event.

- c2acd21: Show annotation-only queued turns in the compact session-chrome queue. A queued turn with an empty prompt and timeline annotations rendered as a blank row; it now shows a keyboard-reachable annotation-count chip ("Review 1 annotation") that opens the existing read-only review dialog, prompt-plus-annotation rows show both, and optimistic queue rows follow the same rule. The compact queue and `QueueSurface` share one presentation rule, and an item with neither a prompt nor annotations shows "Content unavailable" instead of blank space. `TimelineAnnotationsChip` accepts an optional `compact` prop for dense rows.
- 4b39032: Keep assistant progress and prior replies readable in independent turn summaries,
  with rolling tool activity and truthful Working/Worked timing. Remove cross-turn
  folding, text-length display inference, and forced answer anchoring. Add a single
  Latest question navigation callback backed by bounded durable history lookup.
  Keep expanded outer work headers reachable with section-scoped stickiness,
  without stacking nested headers or changing timeline scroll ownership.
  Resolve Latest question against authoritative queue/lifecycle state: focus pending
  prompts in SessionChrome, restore distant started prompts at their actual turn
  boundary, and skip withdrawn prompts without getting stuck on invisible rows.
- 4b39032: Keep standalone completed maintenance compaction visible without creating a live
  work summary. Clear resolved approval waiting from same-turn lifecycle/tool-result
  evidence while preserving historical attention landmarks and renewed approvals.
- 9649fcc: Share retained-image retry and figure markup to keep the session bundle within its existing size budget.
- a5da013: Allow retrying failed saved-image retrieval in the timeline without recapturing screenshots or modifying conversation history.
- 8a9d19e: Add human-authorized removal of saved personal/workspace Skills with version checks and replay after deletion. Allow installed capability shortcuts to display their status visibly.
- a12f4cf: Keep the model picker open after selecting a model so reasoning effort can be adjusted without reopening it.
- e403746: Keep live per-turn progress above one trailing activity disclosure, then fold settled progress and tools together chronologically while leaving the final response visible. Preserve expanded work, manual-reader position and focus, phase-aware duration, attention surfaces, and classic grouping.
- 4b39032: Keep Latest question and earlier-history controls in separate pointer regions
  when both are visible, including narrow mobile layouts. Preserve existing
  history navigation, callbacks, and scroll ownership.
- d480872: An expanded turn's sticky work header now pins flush to the top of the timeline instead of 3.5rem below it, so rows no longer scroll visibly above it; the floating Latest question action sits below the header strip.
- Updated dependencies [3f9c757]
- Updated dependencies [304ddc5]
- Updated dependencies [3f9c757]
- Updated dependencies [378327b]
- Updated dependencies [a6644b6]
- Updated dependencies [aad6598]
- Updated dependencies [e14db2a]
- Updated dependencies [a6644b6]
- Updated dependencies [a6644b6]
- Updated dependencies [d480872]
- Updated dependencies [3f9c757]
- Updated dependencies [9732749]
- Updated dependencies [6f28afd]
- Updated dependencies [b591ea1]
- Updated dependencies [a6644b6]
- Updated dependencies [a82657f]
- Updated dependencies [3f9c757]
- Updated dependencies [57f030c]
- Updated dependencies [3f9c757]
- Updated dependencies [3f9c757]
- Updated dependencies [f986809]
- Updated dependencies [1ea4c69]
- Updated dependencies [11151c6]
- Updated dependencies [12bc3de]
- Updated dependencies [30414a0]
- Updated dependencies [a6644b6]
- Updated dependencies [8a9d19e]
- Updated dependencies [e193b13]
- Updated dependencies [14990d0]
- Updated dependencies [d1f4724]
- Updated dependencies [c823664]
  - @opengeni/sdk@7.4.0

## 7.3.1

### Patch Changes

- 6cbccaa: Keep IME candidate-selection and commit keys local to the browser viewer so composing text cannot move the remote caret or submit a remote form. Continue forwarding committed text and subsequent ordinary keys.

## 7.3.0

### Patch Changes

- 78f1d59: Offer native dropdown choices in BrowserViewer when Chromium page frames omit the popup. Keep selection bound to the observed control and preserve normal input/change events, private-field redaction, and disabled options.
- 7f75daa: Keep long browser session lists scrollable with their action buttons visible, and label browser choices for assistive technology.
- 889a360: Accept fresh browser frames when an attachment renews and its producer restarts the frame sequence for the same page.
- ac83339: Show browser discovery failures and retry target loading instead of displaying a semantic-only browser when session loading fails.
- 1fa1216: Bind browser viewer input to the frame actually painted, cancel stale queued input
  across navigation and target changes, and preserve ordered scroll input. Treat
  plain upstream gateway failures as transport errors without blindly replaying
  browser mutations.
- 1842911: Recover managed browser viewers through the existing session when an unrelated attached Chrome profile loses its connection. Negotiate focused-input observations so native select choices appear after a viewer click, with existing generation fences and explicit fallback for older controllers.
- 6d4ccb9: Preserve keyboard focus after desktop canvas clicks, bind pointer input to the
  painted frame, and discard stale queued gestures and clipboard continuations.
  Keep continuous scrolling responsive while preserving ordered input and deltas.
- ec707de: Negotiate bounded viewer typing batches from the active browser controller. Preserve
  individual text events and input order while reducing request overhead; recheck the
  original document fence before each action and discard uncertain queued input
  without replay. Older controllers retain sequential input.
- 212de3d: Keep queued browser input fences without retaining earlier screenshot bytes or render callbacks. Preserve input order and discard queued actions when their viewer generation changes.
- cc4bc8e: Hide the agent workspace's machine-state chip while viewing independent Browser or Desktop resources. Those viewers retain their own runtime status, so a sleeping agent sandbox no longer makes an active browser appear asleep.
- Updated dependencies [1842911]
- Updated dependencies [585f2c1]
- Updated dependencies [ec707de]
  - @opengeni/sdk@7.3.0

## 7.2.0

### Patch Changes

- 19ecc86: Composer `autoFocus` no longer moves focus out of an open menu, listbox, or dialog when the composer becomes interactive late, so a hydrating composer cannot dismiss a menu the person just opened.
- b85a966: Keep suspended browsers asleep when their viewer opens, and resume only after an explicit Open browser action.
- d0b6742: Detach live browser frames when the page has been hidden, and reconnect when it becomes visible.
- 2eaeec6: Publish the `@opengeni/react/accounts` subpath with its built JavaScript and declaration files. The previous release mapped that export to a source file name the package does not ship, so importing it failed.
- Updated dependencies [084616e]
- Updated dependencies [1a427e0]
- Updated dependencies [6eb431b]
  - @opengeni/sdk@7.2.0

## 7.1.2

### Patch Changes

- 24968dd: Keep retained image retrieval out of compact progress labels so they do not report a missing image loader while the full timeline image remains available.

## 7.1.1

### Patch Changes

- Updated dependencies [3d33f17]
  - @opengeni/sdk@7.1.1

## 7.1.0

### Minor Changes

- bf744ed: Add optional model-policy picker group labels, icons and description overrides for host branding, shared by menu, trigger, accessibility and search without changing model or billing behavior.

### Patch Changes

- 701ea95: Preserve the original shell command when adopting background processes, so running command rows and completion notices show the command instead of execCommand. Keep long command rows ellipsized and expose their saved preview on hover and expansion.
- e9c4379: Resolve published-file Markdown links through host navigation, expose message presentation in SessionConversation, and document exact retained-file link/embed syntax.
- d92af11: Keep original command text through ambiguous launch recovery and persist it separately from bounded previews. Preserve whitespace, mark clipped previews with an ellipsis, and show complete commands on expansion and hover.
- a463199: Increase browser conversation retention from 8 MiB / 10,000 events to 160 MiB / 200,000 events, reducing eviction during history navigation without changing fetch sizes or folding behavior. Account for appended event bytes incrementally instead of serializing retained history on every live batch.
- 2f8bc58: Use bounded readable MCP tool aliases while preserving exact account routing and historical approval rehydration. Retain action and account display metadata in native and Codemode timeline events and approval cards without changing execution or approval identity. Legacy opaque calls resolve only against the current authorized tool catalog.
- dd3387f: Preserve Markdown paragraphs and embedded media when host link callbacks change, preventing selection jumps and video preview restarts.
- a463199: Repair workspace control revisions behind their retained event frontier, preventing historical control replay on each fresh browser load. Reject subsequent revision rollback without altering pause state, timers, or historical events. Stop refreshing last-started model metadata for unrelated control changes.
- Updated dependencies [d92af11]
- Updated dependencies [86c710a]
- Updated dependencies [2f8bc58]
  - @opengeni/sdk@7.1.0

## 7.0.0

### Major Changes

- 1bfb6a4: Remove Packs and their Workflow templates from the application, public clients,
  runtime, and active database schema. Plugins, Skills, Connections, sandbox
  environments, Knowledge, scheduled tasks, and event automations remain independent.

  PR Review now has its own setup authority and fixed automation template. Generic
  automation routes cannot mutate review-owned sources or triggers. The API contract
  revision changes; deploy matching server and client versions together.

  Migration 0482 is a destructive maintenance cutover: drain all API and worker
  database clients, settle Pack-related operations and queued Pack automation work,
  then apply migrations and provision roles before starting only matching binaries.
  It removes Pack data without a compatibility layer or data-preservation migration.
  Historical events mixing Pack and independent automation work block the cutover
  for explicit operator resolution; independent execution history is never silently deleted.
  Customized, shared, and re-scoped Skills, Connections, and session history are
  preserved; source-only Skills lose their active distribution owner.

### Minor Changes

- 3b73fc0: Add server-authoritative session-page sorting by last activity, creation date, or durable name and explicit active, archived, or all archive status. Pagination cursors bind these choices, and clients reject servers that do not acknowledge requested ordering or archive filtering.

  The stock sidebar offers compact Status, Group by, Sort by, and Show empty groups controls with workspace- and subject-scoped persisted preferences.

- 1c924ed: Add authorized, resumable literal search of saved user and completed assistant
  messages, including unloaded history. Workspace search can return one
  representative match per session; in-session Find returns every occurrence with
  stable event identity and original-text UTF-16 offsets. Requests and browser
  result batches remain bounded, with explicit continuation and provisional counts.

  Expose bounded exact-sequence history navigation and message highlighting for
  React hosts. The web console connects a contextual session-search dialog to
  full-history Find, preserves search state across navigation, and keeps ended
  conversations readable. Tool output, reasoning and unfinished delta-only
  assistant messages are outside the initial searchable scope. Exact Markdown
  matches use a labeled source excerpt that stays in place when Find closes;
  readers can explicitly restore the formatted message.

- c66ba31: Unify interactive and trusted-backend OAuth setup on native workspace connections
  with optional canonical-user ownership, persisted lifecycle bindings, native
  credential refresh, and captured execution authority.

  Remove the superseded host binding, delegation, and credential-resolver API/SDK
  surfaces and runtime configuration. Migrate integrations to ordinary OAuth
  connections before upgrading; retired host selections are rejected rather than
  translated or silently replaced. Apply the matching database migrations and role
  provisioning with the runtime. Historical records remain preserved. See
  `docs/remote-mcp-credentials.md` for the cutover contract.

  Share connection setup, provider identity, loading states, conversation cards,
  composer, and activity surfaces between the console and React SDK. Preserve
  personal-account consent and native sharing authority, and keep interaction-only
  connection and command panels outside the initial session bundle.

### Patch Changes

- cf9249d: Keep document typing and paste after a trailing newline, ignore IME composition Enter, and show spreadsheet General numbers without binary residue while leaving stored values and formula-bar source unchanged.
- 4258aeb: Show browsable public Skill results before a search and align Skill and Plugin catalog grids across desktop and mobile.

  Give connection setup a clear primary authorization action and quieter recovery controls, with shared responsive styling.

  Reuse plugin and skill discovery results briefly across tab visits with client/workspace/query isolation, align installed shortcuts, and remove duplicate catalog headings and search affordances.

  Keep All available in Capabilities navigation and cap its ordered category previews at six results, with explicit navigation to the full filtered category.

- c64a94f: Support simultaneous authorized personal and workspace MCP account attachments with immutable account-qualified routing, sender isolation, and scheduled execution binding. Move attachment controls inside Connectors with readable ownership labels; keep account setup on the Capabilities page.
- d5dba2a: Respect composer delivery readiness even when attachments are ready. File-only messages remain supported when the delivery owner reports them ready to send.
- 667a90f: Keep available connection services usable when another catalogue fails or stalls, handle synchronous transport failures, and discard stale discovery results after scope changes.

  Keep the console's Gmail logo fallback independent of the complete service registry so it does not bundle unused provider icons.

- 47a37c8: Align the optional voice-model drill-in header and spacing with the composer's resource menus while preserving model availability and payment-source selection.
- 348e54d: Use Sandbox Environment terminology in user-facing controls, errors, tool descriptions, and runtime guidance. Existing rig routes, tool names, IDs, permissions, and stored definitions remain unchanged.
- aa09567: Preserve explicit host MCP delegation selections through durable composer Send and Steer admission, including exact retries after an uncertain response. Keep existing owner, generation, visibility, revocation and replay checks; omitted selections do not inherit authority.
- 9de8e51: Route missing integration setup through provider-neutral catalog discovery and the shared human authorization card, with an explicit next action for every eligible catalog integration. Continue account selection and installation through owner authorization without an extra launch click, and open repository configuration in a separate tab.
- f3920a7: Add a compact accessible mobile slide selector so presentation editors can jump to any slide when the desktop rail is hidden below `sm`, without changing desktop rail virtualization or keyboard selection.
- 132b945: Add organization-owned integration acquisition policy with a discoverable catalog,
  revisioned administration API and SDK, and organization settings. Enforce selected
  provider and custom-protocol permissions on supported setup and installation paths
  at preparation and persistence boundaries.

  Preserve ordinary ownership and authorization, exact completed-request replay,
  unchanged reconciliation, cancellation and other reducing operations. Existing
  connection execution and credential refresh are not revoked by this policy.
  Deployment-configured tools and embedding-host session-local MCP configuration
  retain their existing admission rules; this is not a network or execution allowlist.

  Apply the organization integration policy migration and matching role provisioning
  with the matching runtime before enabling the setting. Older runtimes do not enforce
  the new acquisition policy. See `docs/organization-integration-policy.md` for the
  administration, identity, persistence and recovery contract.

- 1cb688d: Add explicit permanent Skill removal review bindings and truthful removal receipts.
  Deletion approval is bound to the exact removal proposal; existing save approvals
  cannot authorize irreversible deletion. Review surfaces distinguish removal from
  activation and preserve conversations.
- 621201d: Distinguish queued sessions from running agents and expose durable dispatch wait
  evidence in session detail reads, including retry timing and recorded errors.
- f7e41e7: Show unavailable saved changes previews inside the affected Changes view instead of displaying capture-error notifications when a session opens. Preserve the existing explicit live-workspace action and the live-only Staged view.
- 9d9b94b: Allow plugin discovery to choose an initial registry while preserving all registry filters. The OpenGeni web catalog initially selects OpenAI.
- 6b32304: Reuse the shared activity row and running-command animation for incomplete previews, replacing the standalone loading card while preserving completion and interruption behavior.
- c9e2743: Accept an explicit null skill-review reference on structured human-input questions, matching the contracts wire type without changing API runtime validation.
- 0bf014d: Add a session-authorized Codex account projection. Capacity retry choices follow
  the waiting turn's accepted subscription pool after source changes, including
  Disabled. Running turns keep their accepted account label while next-turn
  choices and workspace settings continue to use the current source.
- c4a2775: Unify provider and MCP service discovery in the embedded connection panel. Preserve Gmail branding for personal accounts without workspace installation references, bundle Outlook branding, share service logo loading, and clarify ownership and tool-selection copy.
- b88890f: Show a neutral pulsing dot and command count on the session activity button, with reduced-motion support. Open command details directly when background commands are present.
- Updated dependencies [6d0a4de]
- Updated dependencies [c64a94f]
- Updated dependencies [3b73fc0]
- Updated dependencies [1c924ed]
- Updated dependencies [c31a951]
- Updated dependencies [f90d628]
- Updated dependencies [3fa175e]
- Updated dependencies [132b945]
- Updated dependencies [779b16b]
- Updated dependencies [1cb688d]
- Updated dependencies [9d9b94b]
- Updated dependencies [621201d]
- Updated dependencies [1bfb6a4]
- Updated dependencies [1641006]
- Updated dependencies [c9e2743]
- Updated dependencies [7e2436a]
- Updated dependencies [0bf014d]
- Updated dependencies [c66ba31]
- Updated dependencies [0ea365c]
  - @opengeni/sdk@7.0.0
  - @opengeni/connect@0.3.0

## 6.1.0

### Minor Changes

- 85cafd0: Add a shared workspace/session artifact catalog over existing Sites, editable artifacts, generated images, and published files. Keep file bytes and content authorization in their existing domains, expose bounded filtered discovery through the SDK, and retain explicit sandbox-file publication provenance. The web Artifacts library includes type/search/sort controls, grid/list views, retained image previews, and file viewers that do not wake compute. Published images use the shared chat image/lightbox presentation; ordinary HTML file downloads remain non-executable.

### Patch Changes

- 71ca29b: Preserve the current history window when loading later activity fails, expose the original error, and offer explicit timeline retry without repeated observer requests. Ignore late failures from a previous session or navigation lifetime.
- Updated dependencies [85cafd0]
  - @opengeni/sdk@6.1.0

## 6.0.0

### Major Changes

- efeaa9c: Replace autonomous Memory and reviewed Knowledge authoring with structured Knowledge entries, exact revisions, evidence, groups and nonblocking review. Add centralized Agent learning defaults with chat and scheduled-task overrides, private original-file ownership, canonical source preparation and rebuildable retrieval. Retire legacy Memory/learning mutation APIs and SDK methods; migration 0461 requires a drained maintenance cutover and the matching runtime. See docs/knowledge.md and docs/deployment.md.

### Minor Changes

- 750060c: Support inline HTML visualizations, retained images, and embedded Sites in chat. Add a plain HTML Site client, preserve application request headers through the shared bridge, document visualization workflows, and use Image 2.5 Sunburst for Codex image generation.
- 46a0267: Load authoritative goals on mount when reusing a shared event feed. Add optional native loading messages for accessible status, slow waits, and details controls, preserving English defaults. Expose SessionChrome's successful queue-checkout composer focus handoff.

### Patch Changes

- 48c624f: Show discovered desktop targets immediately so slow or failed semantic inspection cannot block the live view or switching windows and screens.
- d5582c1: Accept restarted frame sequences after a fresh desktop attachment so automatic renewal does not freeze the last image. Preserve frame ordering within a stream and reject detached sockets.
- 49d43e6: Show desktop connection errors and Reconnect after an established stream fails or socket retries are exhausted, and let Refresh desktops retry a failed stream.
- Updated dependencies [50ac837]
- Updated dependencies [ad9dc2f]
- Updated dependencies [750060c]
- Updated dependencies [da4a85f]
- Updated dependencies [efeaa9c]
  - @opengeni/sdk@6.0.0

## 5.2.0

### Minor Changes

- c1ad490: Allow hosts to localize user-message disclosure actions through direct component props and the default timeline composition. Each label falls back independently to English, while message expansion, accessible controls, and scroll anchoring retain their existing behavior.

## 5.1.1

### Patch Changes

- 0507f91: Retry timed-out composer draft reads with backoff and clear their warning after a successful refresh, including when the draft revision is unchanged. Keep draft-read failures separate from Send, Steer, and control failures, and identify draft sync timeouts in the composer message.

## 5.1.0

### Minor Changes

- d40bd9b: Replace startup timing rows with a quiet animated genie and rotating loading copy. Retain timing evidence in diagnostics, support a browser-local detail preference, and keep failures visible. Add a replayable loading studio.

### Patch Changes

- 4e2b59d: Keep loading animation options self-contained in public declarations so NodeNext consumers do not need to resolve the renderer's internal type imports. Supported animation options and runtime behavior are unchanged.
- 4e2b59d: Route plugin discovery types and endpoint compatibility through the public SDK boundary, using a narrow contracts entry without schema-runtime imports.
- 9968ae5: Allow host rendering of DeviceAuthorization while retaining shared clipboard state and URL validation. Restore the native Codex and SuperGrok subscription sign-in panels without changing embedded defaults or integration setup.
- 488a69b: Expose bounded current-failure evidence on session detail reads so recovery diagnostics do not depend on timeline pagination. Show recorded consecutive retry streaks without inventing lifetime totals, and distinguish Codex account assignment, affinity/lease reuse, and actual switches without changing allocation policy.

  Read session status and its replay cursor coherently, decode bounded diagnostics through the lossless storage codec, and record account transitions atomically against the current assignment with attempt-keyed replay and compatible switch reasons.

- 5ef34cf: Allow hosts to open a workbench tab with `openTabRequest`. The stock console routes Site links into the session artifact panel and retains a session return link when expanding Sites or editors full-page.
- Updated dependencies [4e2b59d]
- Updated dependencies [4e2b59d]
- Updated dependencies [488a69b]
- Updated dependencies [935af4e]
- Updated dependencies [d08dbb6]
  - @opengeni/sdk@5.1.0

## 5.0.5

### Patch Changes

- @opengeni/sdk@5.0.5

## 5.0.4

### Patch Changes

- 3d9ab25: Keep wide markdown tables stable while subsequent message text streams by preserving their layout observer and remeasuring content without resetting the expanded width.

## 5.0.3

### Patch Changes

- @opengeni/sdk@5.0.3

## 5.0.2

### Patch Changes

- 05957ee: Keep the workbench's initial tab unresolved while a signed capture manifest is loading, so pending capture metadata cannot permanently select Files instead of Changes. Preserve host overrides, settled empty/error fallbacks, and the user's later tab selection.

## 5.0.1

### Patch Changes

- be17b8e: Remove the SDK Skill loader capability and use eager sandbox-free Skill reading
  with a turn-prepared descriptor index. Keep on-demand checkout and repository
  Skill discovery separate, and render Skill tool calls consistently in the timeline.

## 5.0.0

### Minor Changes

- f8be7df: Allow hosts to render inline connection setup for timeline authentication requests. Add an optional safe return path to Fiken OAuth so setup can return to the originating conversation.
- cffd21b: Add organization-scoped external users, explicit native identity linking, shared
  white-label Connect flows and Site lifecycle/bridge surfaces. Add opt-in durable
  host-MCP delegation and renewal while preserving simple short-lived credentials,
  existing schedule authority and approval behavior. Share native/embedded device
  polling and setup components, and synchronize developer integration Skills with
  the installable Product Integration Pack.

  Database migrations 0437–0457 require the documented maintenance/cutover procedure;
  older API and worker writers must not be restarted after activation. Provider
  OAuth applications and host resolvers remain deployment configuration, not
  automatic external provisioning. No package is published by this changeset.

### Patch Changes

- Updated dependencies [cffd21b]
- Updated dependencies [f8be7df]
- Updated dependencies [cffd21b]
  - @opengeni/sdk@5.0.0
  - @opengeni/connect@0.2.0

## 4.0.2

### Patch Changes

- 39adecb: Let top-level assistant tables expand into available chat panel space while keeping surrounding text at its normal reading width. Tables remain contained when a side panel opens or the conversation is narrow, and keep horizontal scrolling when content still cannot fit.
- 1b0f4f2: Expose unavailable background command observations separately from command lifecycle state, and render that uncertainty in command and session status.
- 87fbd92: Preserve full session messages and tool output through database paging, compact
  event delivery, SSE, browser rendering, and copying. Remove browser per-event
  preview truncation while retaining history pagination and backpressure. Events
  larger than a page or loaded-window byte target are delivered intact on their own.
- Updated dependencies [1b0f4f2]
  - @opengeni/sdk@4.0.2

## 4.0.1

### Patch Changes

- 068be26: Complete a Skill save in the same transaction as its one verified human chat decision. Show the full immutable Skill folder, preserve exact scope and revision checks, and refuse delegated, stale, or mismatched approval. Autonomous saves activate directly; declining a proposal preserves existing active guidance.
- d1cb266: Keep automatic history filling from evicting the latest reply or cycling between older and newer pages. Preserve explicit history navigation and stable jumps back to latest. Retain provider message identity so assistant chunks interleaved with tool activity remain one message without merging distinct replies.
- Updated dependencies [068be26]
- Updated dependencies [2fa33e4]
  - @opengeni/sdk@4.0.1

## 4.0.0

### Major Changes

- c915b0f: Remove the separate `@opengeni/react/chat` component. Use the existing
  `SessionConversation` or compose the timeline and composer for the full agent
  experience. The server-side `@opengeni/sdk/chat` wrapper and adapters remain
  unchanged; their protocol requires a custom or compatible frontend.

### Minor Changes

- 9827c25: Add message action slots and an optional source message boundary for managed-human forks. The web UI places turn feedback and Fork from here beside Copy and the timestamp. Message forks preserve existing authorization and idempotency, copy only the selected canonical history prefix, and reject ambiguous, compacted, or incomplete boundaries.

  Migration 0429 requires draining the API and both worker pools and provisioning the updated runtime routine contract before starting the new binary.

### Patch Changes

- 0c5e2fd: Group composer timeline annotations into one count chip, pin numbered badges on the quoted source text, and keep Add note available for long highlights that end in message chrome. Dense and long notes stay in a viewport-clamped review list, overlapping badges pack onto distinct in-viewport points instead of stacking, Enter moves to the next empty note, and sent cards collapse instead of growing without bound.
- 231b103: Apply explicit Codex account switches and unpins to capacity-blocked turns, preserving the same turn and history through recovery. Display current account selection separately from future preferences and report when a switch requests a capacity recheck.
- 9d36a0f: Keep the latest streamed answer visible outside collapsed steps when an input wait ends a turn without final output.
- Updated dependencies [231b103]
- Updated dependencies [9827c25]
- Updated dependencies [5904fd1]
- Updated dependencies [14dd6fe]
  - @opengeni/sdk@4.0.0

## 3.8.0

### Minor Changes

- b1d3673: Add the `@opengeni/sdk/chat` facade (`OpenGeni`, `Chat`, `createChatHandler`, Vercel AI SDK and OpenAI adapters) and the `@opengeni/react/chat` drop-in component. Sessions gain `agentAccess`, an opaque `endUser` label, and `memoryScope`, enforced in the session-authorization seam so one workspace per customer can hold isolated, per-user, or shared chats. Organization API keys gain `access: "read"` and `GET /v1/organizations/:id/sessions`. Close the tool-widening paths: child tool selection, agent tool-policy updates, scheduled-task sessions, and the Codemode SDK proxy can no longer exceed the creating session.

  Private-memory identities use bounded hashes of exact source/user tuples. Correction, archival, and replacement enforce the private writable scope. Chat reload restores unresolved approvals and questions, and the chat component uses the complete human-input form with multiple selections and Other answers.

  Session-scoped discovery preserves the embedding host's allowlist. Responses streams emit the complete message/content lifecycle with stable per-response IDs, including incomplete settlement for human waits and cancellation. Streaming text preserves the same paragraph separators as the final reply.

- 107aa14: Support standard SDK/React conversations in Sites and sandbox previews, direct
  HTML/source uploads, exact deployment package pins, and embedded layout/queue
  defaults. Refresh exhausted Grok capacity after external resets.

### Patch Changes

- 0ca6728: Label child-result receipts without claiming task completion, explain pending input, and let hosts open the exact child from incoming and delivered updates.
- fa2b99a: Preserve workflow wake retries until pending input is admitted, while future waits stay parked at their deadline, and expose current session waits and waiting descendant counts. Refresh wait status on live events and retain the status projection sequence so newer session reads cannot be overwritten by older events.
- 1fc0889: Group deployment-provided models under OpenGeni regardless of upstream provider. Badge only explicitly free models, keep paid rows compact, and preserve separate workspace, organization, and subscription connections with accurate payment descriptions.
- e271780: Replace nested model selection with a searchable list grouped by payment source. Select models immediately, keep thinking and speed controls visible in the picker footer, and preserve supported settings when switching models. Prioritize model names in compact composer controls.
- 952331e: Restore click-to-expand previews for ready image attachments after their composer remounts, while keeping signed preview URL creation lazy.
- ecffc88: Use the selected appearance for message-detail backgrounds instead of the operating system theme.
- 8be8a72: Show failed live-file wake requests with a retry that renegotiates the workspace, instead of leaving a permanent waking spinner. Preview complete PNG, JPEG, GIF, and WebP files without enabling binary editing or waking machines during passive capture browsing.
- ba890d1: Keep selected models in their provider groups, consolidate subscription descriptions, and simplify reasoning controls. Show image compatibility warnings only when a draft contains images.
- 730b78b: Identify the goal explicitly in compact status chips so its state is distinct from the session status.
- e9d092a: Resolve goal landmark icons when rendered so circular production chunks cannot leave continuation rows permanently unavailable.
- ca2b4e2: Offer the session-chrome queue when chrome is idle and at least one authoritative prompt is waiting. Closing it dismisses that session until occupancy drains; a different session on the same chrome instance may still offer. A live Send stays a paint-only chip receipt.
- 3673900: Preserve reading position during session history pagination, keep folded history loading, and prevent false retries across stream reconnects.
- 3a29372: Keep embedded conversation foreground and background theme-matched. Support filtering published Sites by creating or publishing session for the session Artifacts panel.
- eeb5500: Label preserved wait outcomes with their recorded date and time and expose them as static notes, keeping historical agent text distinct from current session state.
- 0f3dc9a: Keep an unpinned timeline reader in place when older history prepends into a compact tail. Restoring the row offset no longer looks like a scroll back to the live tip, so the view does not snap to the bottom after loading earlier messages.
- fe73da9: Keep hidden composer height measurement out of document overflow after responsive resizing. Allow session chrome hosts to identify an active goal blocked by failed session execution without changing the goal state.
- d8a70ec: Unify first-party and integration tools behind one workspace gateway for MCP, model execution, Codemode, SDK, and browser clients; require host-confirmed SDK approval for human-gated model calls, keep Codemode claims live through gateway preparation, and deduplicate reclaimed tool-created events; add opt-in resource-bound MCP OAuth; ship governed self-contained HTML Sites with retained source, version rollback, an exact-version direct-call tool allowlist, and a native Site-authoring Skill; and default Modal self-hosts to OpenGeni's public digest-pinned desktop runtime image.
- f0f1e17: Keep a durable wait reason visible after a tool-only turn settles, including legacy goal holds, while preserving collapsed step detail and recovering missing or partial terminal responses from authoritative turn output.
- Updated dependencies [4536385]
- Updated dependencies [fa2b99a]
- Updated dependencies [fa12951]
- Updated dependencies [d06450c]
- Updated dependencies [d9dbd5d]
- Updated dependencies [1c4b707]
- Updated dependencies [cc1bfe0]
- Updated dependencies [3db0b05]
- Updated dependencies [c90f3fc]
- Updated dependencies [0c39126]
- Updated dependencies [0c39126]
- Updated dependencies [4708cfb]
- Updated dependencies [575af5b]
- Updated dependencies [6de9fe3]
- Updated dependencies [cda46e8]
- Updated dependencies [b1d3673]
- Updated dependencies [2fb17fd]
- Updated dependencies [3a29372]
- Updated dependencies [107aa14]
- Updated dependencies [d8a70ec]
- Updated dependencies [0a81cc8]
  - @opengeni/sdk@3.8.0

## 3.7.0

### Patch Changes

- 6b65383: Replace goal-scoped long waits with self-only session-level `wait_for_input`, add provider-neutral `command_wait`, and deliver terminal background-command proof as exactly-once durable agent input with workflow wakes for nonterminal sessions while preserving event-only audit for terminal sessions.
- 6f84c02: Make durable Codex credential leasing unconditional, preserve rotation-off as an active-account-only capacity policy, and recover definitive credential failures through same-turn failover or durable capacity waiting.
- Updated dependencies [6b65383]
- Updated dependencies [6f84c02]
  - @opengeni/sdk@3.7.0

## 3.6.0

### Patch Changes

- d63ee0f: Keep Connected Machine file links in the target's canonical filesystem namespace, including Windows drive and UNC roots, and reject stale file requests with a retryable route conflict.
- fab39d2: Keep lazy session-history reads sub-second on large sessions by fitting each browser window and its continuation lookahead into one byte- and count-bounded database query instead of walking the page through sequential reads. Fresh and foreground tail loads may use one additional bounded page to preserve a complete turn boundary, and foreground replacement keeps the prior timeline visible until the new window is ready.
- Updated dependencies [d63ee0f]
- Updated dependencies [b420912]
  - @opengeni/sdk@3.6.0

## 3.5.1

### Patch Changes

- Updated dependencies [8b42f58]
- Updated dependencies [0214875]
- Updated dependencies [e2a668b]
- Updated dependencies [9c45eae]
  - @opengeni/sdk@3.5.1

## 3.5.0

### Patch Changes

- 633f9bf: Reconcile sustained hidden-tab sessions by measuring their durable event gap: replay tiny gaps normally, append semantically small compact catch-ups in one paint, and reload the latest tail only for large or complex backlogs.
- Updated dependencies [32b9de4]
- Updated dependencies [8f81b57]
  - @opengeni/sdk@3.5.0

## 3.4.2

### Patch Changes

- b88a194: Stabilize timeline annotation interactions when lazy UI effects settle under load.

## 3.4.1

### Patch Changes

- a8da2c5: Stabilize release admission checks under loaded CI runners.

## 3.4.0

### Minor Changes

- 2d0fad4: Add deployment-defined model catalogs and cost policy, workspace-managed Gateway and OpenRouter credentials plus custom models, a separate deployment-managed OpenRouter rail, live catalog refresh, the `list_models` agent tool, and model-picker/API/SDK support for the new catalog surfaces.
- 9fe5c5b: Add organization-scoped Vercel AI Gateway and OpenRouter BYOK/custom models for shared workspaces while preserving independent workspace connections.

### Patch Changes

- c356468: Add explicit host authority provenance for opaque MCP connection references so embedding hosts can resolve any binding identity, including UUID values, without native delegation, catalog, attachment reauthorization, or reconnect flows reinterpreting it. Preserve the legacy non-UUID host-binding lane during rolling upgrades, retain host provenance after successful credential resolution, make auth-needed events inert in legacy browsers, and gate newly marked refs behind a default-off two-phase fleet activation.
- dd98677: Fail browser uploads before any network request with a typed `secure_context_required` error when HTTPS-only Web Crypto is unavailable, and surface actionable HTTPS guidance directly on failed attachment cards.
- 9af1666: Keep backward session-history pagination advancing across oversized legacy events by applying the canonical bounded read projection instead of failing the page, and report when a forensic response is no longer byte-for-byte exact.
- Updated dependencies [2d0fad4]
- Updated dependencies [9fe5c5b]
- Updated dependencies [c356468]
- Updated dependencies [dd98677]
- Updated dependencies [9af1666]
  - @opengeni/sdk@3.4.0

## 3.3.2

### Patch Changes

- Updated dependencies [5b9acd1]
  - @opengeni/sdk@3.3.2

## 3.3.1

### Patch Changes

- Updated dependencies [b471a90]
- Updated dependencies [96624a7]
- Updated dependencies [4bacdd3]
  - @opengeni/sdk@3.3.1

## 3.3.0

### Patch Changes

- Updated dependencies [ddce5cc]
- Updated dependencies [132c8d3]
  - @opengeni/sdk@3.3.0

## 3.2.1

### Patch Changes

- fd05df1: Cancel abandoned session detail, lineage, and goal reads after their final mounted consumer leaves while preserving shared reads for consumers that are still active.
- 7988c84: Fence the initiating browser tab before account-changing mutations and cancel abandoned session-page, draft, turn-policy, model-catalog, and realtime-catalog reads without interrupting remaining shared consumers.
- f499d32: Reconcile browser account authority when an invalidation supersedes the initiating fence or post-mutation host settlement, prevent stale dispatch after the peer-hold yield, and discard superseded retry commands.
- Updated dependencies [fd05df1]
- Updated dependencies [7988c84]
  - @opengeni/sdk@3.2.1

## 3.2.0

### Patch Changes

- 80d7594: Show a bounded, sensitive-safe opening-prompt preview while a session's durable automatic title is still pending, then yield automatically to the semantic agent title or a human rename.
- Updated dependencies [595939e]
- Updated dependencies [80d7594]
  - @opengeni/sdk@3.2.0

## 3.1.1

### Patch Changes

- ff4af61: Promote a normal human Send to Steer-equivalent replacement when an active session is waiting for human action, cancelling the stale decision surface and placing the conversational message directly in chat.
- 0bbaee2: Harden live and historical session timelines: preserve reader ownership through cumulative pointer movement and animated layout shrink, keep bidirectional history windows density-bounded and compact-cursor correct, schedule large window swaps without blocking the browser, and prevent unmatched tool outputs from settling unrelated calls.
- Updated dependencies [17d253b]
- Updated dependencies [c116379]
  - @opengeni/sdk@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [7238fa4]
  - @opengeni/sdk@3.1.0

## 3.0.0

### Major Changes

- c525324: Add clickable composer attachment previews through the shared route-level lightbox with safe retained object-URL lifetimes, localized preview and lightbox control messages, full-chat file drag-and-drop affordances, and the updated reduced-motion-aware working indicator.

### Patch Changes

- c52c841: Show the timeline's Jump to latest control while a pinned session is catching up from meaningful pre-existing tip debt.
- 3887ad2: Bound composer draft read retries and ignore unchanged soft-reload projections to prevent request feedback loops during reconnects and transient gateway failures.
- 3a004ff: Preserve optional structured human-input answers, replay terminal settlements idempotently, and retain Slack replies when expiry or cancellation wins a response race.

## 2.6.0

### Minor Changes

- 5d4edd4: Add a public atomic composer application command shared by HTTP and in-process hosts, including atomic host-authorized resource augmentation without a trusted draft rewrite; add a receiver-safe narrow React session client constructor with host submit overrides and draft projection; and add presentation-only file-node filtering across the packaged workbench surfaces.
- 986f5fe: Add provider-neutral browser login session sets with bounded independently revocable slots, explicit actor switching, isolated add and re-authentication, scoped logout, non-enumerating cross-slot deep-link recovery, and rolling legacy/dual/broker compatibility.

### Patch Changes

- f1f7c22: Keep controlled composer inputs on the latest local draft while older autosave settlements render.
- 720ca4a: Render controlled composer edits synchronously before deferred host delivery settles.
- 27f3364: Clear ordinary Send drafts before host submission callbacks can re-project the submitted text.
- 82e72ce: Preserve the latest controlled composer edit across synchronous child-controller renders.
- 1135a6b: Keep pinned session streaming at the rendered layout tip so the viewport no longer reveals already-rendered output through a delayed catch-up glide.
- Updated dependencies [a7912ea]
- Updated dependencies [9ef491b]
- Updated dependencies [986f5fe]
- Updated dependencies [6e12f3a]
- Updated dependencies [9a8c822]
  - @opengeni/sdk@2.6.0

## 2.5.0

### Minor Changes

- 76d6396: Generate concise topic-oriented session titles with a prompt-free fallback, automatic-title safety normalization, custom-role and old-image rolling-compatible least-privilege database posture, and UI projections that never use raw initial prompts as display names. Durable title fanout now requires a versioned subscriber-recovery capability: managed NATS and supported embedded brokers coalesce one Postgres catch-up after reconnect, while legacy buses without that contract fail readiness/worker startup before durable rows can be acknowledged.

### Patch Changes

- 85e4f3c: Release committed older-history pagination ownership when projected rows stay unchanged, while preserving the legacy public callback return compatibility.
- d741f38: Make fresh session reads generation-aware, expose authoritative detail and list read revisions plus causal read generations, and keep retained pagination and independently polled pinned projections from overriding newer session channel authority.
- Updated dependencies [d741f38]
- Updated dependencies [b5071cf]
  - @opengeni/sdk@2.5.0

## 2.4.0

### Patch Changes

- c10f396: Keep one completed commentary reply visible when a tool-bearing turn settles without a final answer, including goal-wait holds, while preserving ordinary finals and avoiding disclosure duplicates.
- Updated dependencies [47b88d3]
- Updated dependencies [c5e4684]
- Updated dependencies [977fa0f]
- Updated dependencies [9d251cb]
- Updated dependencies [dc10a36]
  - @opengeni/sdk@2.4.0

## 2.3.0

### Patch Changes

- 4d83368: Separate worker-claim queue state from prompts genuinely waiting behind work, keep rapid sends on stable chat and queue surfaces, and make local development fail fast when schema or aggregate runtime readiness is lost.
- Updated dependencies [1b21135]
- Updated dependencies [f30555c]
- Updated dependencies [47ccfab]
- Updated dependencies [b74e557]
- Updated dependencies [6fd5aee]
- Updated dependencies [0fbf6b0]
- Updated dependencies [b2cd0f0]
  - @opengeni/sdk@2.3.0

## 2.2.0

### Minor Changes

- 4be2055: `requireSessionAuthorization` denies `session.approval.write` to every agent attempt on every surface: tool approvals stay human-only, while structured human input (`session.human_input.write`) remains answerable by a live attempt. The React queue chrome and timeline label the new child lifecycle notice kinds (`child_requires_action`, `child_requires_action_resolved`, `child_paused`, `child_waiting_capacity`, `child_progress`) instead of dropping them.
- 5d664d8: Surface why a goal is not pursuing and how long children have waited for a human. `Session.treeStats` gains optional `attentionSince` (earliest `requires_action` entry among the counted attention descendants), `Session` gains optional `requiresActionSince` on list and lineage reads, and the goal continuation projection gains optional `holdReason` for a `held_for_input` hold. `SessionChrome`'s goal pill spells out the pause reason ("Paused · cap" / "budget" / "by you" / "agent"), explains an idle-backoff check time and an agent `goal_wait` hold, and exports `sessionChromeGoalPillLabel` / `sessionChromeGoalPillExplanation`.

### Patch Changes

- e6ffdc7: Add the `backoff_pending` goal continuation reason (idle pacing between consecutive no-input continuations, `nextAttemptAt` at the pacing deadline) and the `SessionGoalResumedReason` / `SessionGoalResumedEventPayload` contracts for `goal.resumed` (`api` for the operator PATCH, `external_input` for the system resume of a `max_auto_continuations` pause). The React goal pill treats `backoff_pending` as ordinary scheduled work.
- 5e9795c: Derive Connected Machine list state from the durable heartbeat cursor instead of a live ControlRpc ping on every `GET /machines`, and share one `useMachines` poll per workspace+session.
- acd38d1: Retire Browser and Desktop resources when their source task leaves the Connected Machine that owns their controller, stop retrying the terminal placement conflict, and let Desktop create one replacement on the task's current placement.
- e91d89e: Open Markdown `sandbox:` file links in the current session's Files workbench, preserve exact decoded paths through the selected filesystem authority, reveal deep lazy-tree ancestors, and handle malformed references safely.
- Updated dependencies [4be2055]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [bbd19e0]
- Updated dependencies [5d664d8]
  - @opengeni/sdk@2.2.0

## 2.1.1

### Patch Changes

- Updated dependencies [ab81e47]
  - @opengeni/sdk@2.1.1

## 2.1.0

### Minor Changes

- 438e476: Add explicit anonymous OpenAI-compatible model providers with credential-free
  transport, external billing attribution, catalog readiness, and an External
  picker rail while preserving older client parsing by classifying the route from
  existing billing metadata instead of widening closed client enums. Anonymous
  providers reject all configured request headers and query parameters, and the
  runtime strips credential-like headers as a defense in depth. Document the
  temporary OpenCode Zen free-preview configuration.
  Generic Chat Completions routes also reject an `unknown` finish reason before
  accepting a terminal response, so the same accepted turn recovers from durable
  history without executing tools from ambiguous output.
- fbc760e: Add the first-party `goal_wait` MCP tool and a durable goal continuation hold.
  An orchestrator whose active goal depends on child sessions or an external
  event records a bounded hold (reason plus mandatory deadline, at most 7 days)
  with a `goal.held` timeline fact instead of busy-polling. The continuation
  materializer returns `held` while the declaring turn is still the latest
  finished turn and the deadline is ahead: it never consumes the goal wake
  revision and re-arms a delayed workflow wake at the deadline on every idle
  evaluation. Pending machine input wins with `queue`, and any newer finished
  turn, a passed deadline, or a human/API/agent goal mutation clears the hold.
  The goal projection reports a current hold as `blocked` / `held_for_input`
  with `nextAttemptAt` at the deadline (rolling migration 0317).
- c9faa51: Replace the horizontally scrolling workspace tabs with a responsive vertical
  activity rail, add a panel-local Hide workspace action, and distinguish managed
  sleeping compute from genuinely offline Connected Machines.

### Patch Changes

- 66593eb: Reconcile and verify the session-list visibility predicate grant when a fresh
  deployment runs migrations before creating its restricted application role,
  and keep app-supplied composer controls shrinkable within a single footer row.
- 650d6f9: Route OpenSandbox browser and computer streams through the API frame-proxy so the workbench can show live JPEG/RFB when the lifecycle proxy cannot carry browserd WebSocket grants.
- 52456f9: Expose the personal-resource attachment contracts from the SDK and preserve
  atomic attachment intent through durable React composer Send/Steer delivery,
  including exact uncertain retries and authoritative stale-epoch
  reconfirmation. The managed web console can now choose fixed personal Variable
  Sets and Rigs for create and attach them with once, session, or always scope.
- 5880ec8: Keep channel/project hooks cache-coherent across mounted consumers, including immediate confirmed-create projections with stale-read protection and failure rollback.
- 428300c: Open agent `sandbox:/workspace/...:line` links in the Files workbench at that line, and accept `/workspace/...` hrefs as the same session-local file shape.
- 0e5a644: Keep structured human-input decisions in the main conversation: pending forms
  render at the timeline tip, settled history preserves both the agent's question
  and the human's readable answer, the duplicate generic Ask step is omitted, and
  every choice question offers an inline Other answer without losing exact text.
- 7918925: Keep optimistic user messages continuously mounted while their canonical durable events arrive, and show actionable delivery failures without an ordinary sending label.
- Updated dependencies [3e1ad07]
- Updated dependencies [438e476]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
- Updated dependencies [9b4d5d5]
- Updated dependencies [492fb71]
- Updated dependencies [fbc760e]
- Updated dependencies [650d6f9]
- Updated dependencies [fe54954]
- Updated dependencies [f7497fd]
- Updated dependencies [ff011e6]
- Updated dependencies [ba0be3d]
- Updated dependencies [52456f9]
- Updated dependencies [c7cafb1]
- Updated dependencies [5a651c8]
- Updated dependencies [48b9f09]
  - @opengeni/sdk@2.1.0

## 2.0.1

### Patch Changes

- 6f61d6e: Mint public `wss` live-view proxy URLs behind TLS terminators. Drain existing sandbox leases even when ownership is off. Treat ownership-disabled stream-capabilities as no live sandbox.
- 21728f0: Preserve in-progress structured human-input answers when live session updates refresh the same pending request.
- Updated dependencies [6f61d6e]
  - @opengeni/sdk@2.0.1

## 2.0.0

### Minor Changes

- 1c78ed0: Separate new-session and established-session composer policy authority. Exact draft submission now atomically freezes queued-turn text, resources, model, reasoning, and latency, then rotates the server draft; queue Edit restores that exact snapshot and stale revisions surface as conflicts instead of silent rebases.

### Patch Changes

- 5dc88ef: Terminalize attached Chrome Browser/Computer sessions when the device connection generation changes, stop Reconnect from retrying the stale placement, and physically stop ScreenCaptureKit helpers so replayd cannot accumulate.
- Updated dependencies [1c78ed0]
- Updated dependencies [79ee99b]
- Updated dependencies [2cb04e0]
  - @opengeni/sdk@2.0.0

## 1.2.0

### Minor Changes

- b05130a: Hard-cut editable spreadsheets to authored-only canonical state, deterministic formula projections, and explicit current compatibility protocols. Preserve React compatibility with artifact-tool 0.1 and 0.2 while adding the 0.3 line.

### Patch Changes

- 0a6c577: Keep periodic workspace snapshots off the first provider-request critical path, clarify the overlapping runtime/model-preparation timing in the session timeline, and promote the complete signed Agent 0.1.16 bundle as the default stable installer target.
- Updated dependencies [b05130a]
  - @opengeni/sdk@1.2.0

## 1.1.1

### Patch Changes

- @opengeni/sdk@1.1.1

## 1.1.0

### Minor Changes

- 1f860f0: Add durable publication and authenticated download support for session sandbox files. Agents can publish bounded `/workspace` outputs through a first-party tool, raw sandbox links can recover through the session API, retained file receipts render with downloads, and retained screenshots expose an explicit download action.

### Patch Changes

- 987742d: Reduce turn-start overhead without reducing admitted history, rig variables, or
  user-visible content. Active history loads in one admitted query, automatic
  compaction skips duplicate history work below threshold, unchanged Codex
  credential pointers avoid redundant session-activity writes, rig defaults
  load at bounded concurrency for admitted worker attempts, and the attempt-scoped
  MCP wrapper no longer reuses a broader process-global tool list.

  Improve large-session interaction by measuring rich-message disclosure without
  a second React commit, showing truthful pending queue actions immediately, and
  replacing the false zero-step placeholder with the session's real lifecycle.

- Updated dependencies [ca75ed9]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [1f860f0]
- Updated dependencies [c297fc0]
- Updated dependencies [22c0c21]
- Updated dependencies [30ba620]
- Updated dependencies [6860c5f]
- Updated dependencies [c297fc0]
- Updated dependencies [6c45ceb]
  - @opengeni/sdk@1.1.0

## 1.0.3

### Patch Changes

- 2a69f65: Keep versioned direct-session web builds within the measured release bundle contract.

## 1.0.2

### Patch Changes

- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- 4d1ed07: Preserve complete bounded lazy-search tool schemas across durable model history, expose Linux desktop application launch when the image supports it, suppress the managed Chrome sandbox warning, label Computer sessions as Desktops in the UI, and keep AnyDoc available in headed desktop sandboxes.
- 79f57b5: Present an active goal yielding to a foreground human turn as waiting instead of blocked, and keep active-goal elapsed time advancing.
- ffbbf4c: Add organization, workspace, and owner-private Variable Set scopes with independent metadata, plaintext-read, write, attachment, and runtime-use authority. Runtime secret materialization now revalidates the exact live attempt and personal grant immediately before ciphertext egress while audits remain value-free.
- d34dd9a: Add revision-fenced per-command memory and CPU policies for Connected Machines, exact live runner capability gating, and lifecycle-safe Linux operation accounting without introducing default resource limits.
- Updated dependencies [90c0c3e]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [d2f172c]
- Updated dependencies [c056063]
  - @opengeni/sdk@1.0.2

## 1.0.1

### Patch Changes

- 8bb860b: Keep embedded client configurations synchronized with the exported API contract revision and document the fail-closed host integration boundary.
- Updated dependencies [8bb860b]
  - @opengeni/sdk@1.0.1

## 1.0.0

### Major Changes

- 083387e: Replace the removed per-turn `turnInstructions` system-prefix contract with generic per-message `modelContext` content. This is a breaking release-train cutover: old mutating clients are rejected after migration 0240. Context now enters canonical user history without standard timeline rendering, preserves the persistent prompt-cache prefix, and works across initial, queued, steer, realtime delegation, and transcript handoff paths.

### Patch Changes

- 1ef18cc: Deduplicate realtime model catalog loads and reuse settled catalogs across embedded control remounts.
- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/sdk@1.0.0

## 0.57.0

### Patch Changes

- d86610d: Prevent deterministic model-generated worker-spawn failures, hide exhausted nested-agent creation, and show bounded structured session orchestration diagnostics in worker timeline rows while preserving the advanced public REST/SDK create contract.
- d86610d: Run published HTML artifacts as exact source in an opaque-origin sandbox, raise their UTF-8 ceiling to 4 MiB, and expose reusable React rendering. Add deployment-configurable default and allowed built-in session tools plus configured shared-key delegation fallback.
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/sdk@0.57.0

## 0.56.0

### Minor Changes

- b0b2bed: Add unified browser and computer interaction APIs, reusable browser identities, native input, live streaming, and React viewer controls across managed sandboxes and connected machines.

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/sdk@0.56.0

## 0.55.0

### Minor Changes

- 8beed26: Add managed-human organization membership discovery. Expose the exact active
  self-membership and personal-workspace identity returned by the existing
  narrow provisioning capability through a managed-session-only API route and
  typed SDK method, while denying delegated/API-key principals and terminal
  memberships.

### Patch Changes

- Updated dependencies [8beed26]
  - @opengeni/sdk@0.55.0

## 0.54.0

### Patch Changes

- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
  - @opengeni/sdk@0.54.0

## 0.53.1

### Patch Changes

- @opengeni/sdk@0.53.1

## 0.53.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.

### Patch Changes

- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
  - @opengeni/sdk@0.53.0

## 0.52.1

### Patch Changes

- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.
- Updated dependencies [5c5ea4a]
  - @opengeni/sdk@0.52.1

## 0.52.0

### Patch Changes

- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/sdk@0.52.0

## 0.51.0

### Minor Changes

- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.

### Patch Changes

- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.
- 76e54a9: Keep mobile voice-input Cancel and Stop controls visible while recording in crowded composer footers.
- bd5514e: Add explicitly enabled provider-neutral knowledge-source schedules with durable wake provenance, generation-fenced execution checkpoints and index obligations, fail-closed ACL activation seams, no-agent execution, layered pause state, shared schedule administration, and Google Drive source lifecycle integration.
- 90eea29: Make connected-machine removal show every dependent session and support an explicit canonical move-to-default-sandbox confirmation before revocation. Default moves prove managed sandbox readiness through the existing fleet route, active turns remain fail-closed, and typed swap rejections surface as visible errors instead of false success.
- Updated dependencies [b46f4de]
- Updated dependencies [2f4ce5e]
- Updated dependencies [d55a093]
- Updated dependencies [dcfe6eb]
- Updated dependencies [ad9123b]
- Updated dependencies [bd5514e]
- Updated dependencies [90eea29]
- Updated dependencies [a858835]
  - @opengeni/sdk@0.51.0

## 0.50.1

### Patch Changes

- 98b94e8: Project physical cancellation immediately from atomic Steer and Pause receipts, then reconcile it against durable queue truth.
- Updated dependencies [98b94e8]
- Updated dependencies [2cd6dce]
  - @opengeni/sdk@0.50.1

## 0.50.0

### Minor Changes

- 7b2d5ff: Add trust-gated in-session capability recommendations, human-owned authorization
  requests, and a GitHub owner-consent flow that returns to the initiating session.
- d1189ba: Add the OpenGeni-owned document, spreadsheet, and presentation authoring engine,
  its durable API/domain/live-sync surfaces, first-party React workbench, and
  editable-artifact client SDK. Publish independently lazy, identity-pinned browser
  WASM runtimes for each editor modality.

### Patch Changes

- Updated dependencies [7b2d5ff]
- Updated dependencies [d1189ba]
  - @opengeni/sdk@0.50.0

## 0.49.9

### Patch Changes

- 727b186: Keep the session timeline entry compatible with React Native Metro and Hermes bundles.
- 245baf7: Preserve Changes rail focus and scroll while safely resetting virtualization after diff shrinks.

## 0.49.8

### Patch Changes

- ef78ecf: Separate credential-free capability discovery from exact, permission-checked live-plane grants; mint terminal credentials just in time, preserve first input across connection setup, and bound pre-open terminal memory.
- Updated dependencies [ef78ecf]
  - @opengeni/sdk@0.49.8

## 0.49.7

### Patch Changes

- 422d1d8: Expose semantic terminal readiness, prevent pre-connect focus from silently dropping keystrokes, and let browser automation wait for live PTY input.

## 0.49.6

### Patch Changes

- 49be13b: Preserve dirty code-editor buffers and their guarded-save baseline across live same-file refreshes.

## 0.49.5

### Patch Changes

- 6f31d0d: Require an authoritative warm sandbox before capture-backed workbench hooks issue live reads during capability negotiation.

## 0.49.4

### Patch Changes

- e627d88: Keep known-cold sandbox views passive, fence delayed live-read invalidations across draining transitions, and expose bounded structural Channel-A failure diagnostics without leaking provider details.

## 0.49.3

### Patch Changes

- e2edfbc: Add provider-aware image generation with permanent verified artifacts,
  prompt-cache-safe history, sandbox materialization, and SDK/React rendering.
- db82911: Keep teardown-owned workspaces capture-backed until explicit reacquisition reaches warm, and prevent historical events or capability reads from issuing provider I/O during teardown.
- Updated dependencies [e2edfbc]
  - @opengeni/sdk@0.49.3

## 0.49.2

### Patch Changes

- bdac906: Open the live desktop automatically when its viewer mounts instead of requiring a confirmation click.
  - @opengeni/sdk@0.49.0

## 0.49.1

### Patch Changes

- bdbdf5c: Render bounded tool-output previews with explicit delivery and full-evidence truncation facts.

## 0.49.0

### Patch Changes

- Updated dependencies [bb9a346]
  - @opengeni/sdk@0.49.0

## 0.48.2

### Patch Changes

- 74e7a31: Cancel Modal commands that stall before provider yield without bypassing physical quiescence, and show the truthful stopping state while replacement work waits.

## 0.48.1

### Patch Changes

- 86bd95c: Preserve committed-only workspace captures and load multi-repository Git changes in bounded batches.

## 0.48.0

### Minor Changes

- fed43cf: Make embedded Files and Changes durable and responsive: capture complete branch comparisons, batch file-frontier and multi-repository Git reads behind one sandbox lease, preserve live stream responsiveness during reconciliation, harden portable sandbox reads, and polish the workbench's file tree, resizable panes, machine/terminal states, and embedded composer geometry.

### Patch Changes

- Updated dependencies [fed43cf]
  - @opengeni/sdk@0.48.0

## 0.47.1

### Patch Changes

- 5dfb93d: Keep derived design tokens available through both the compiled stylesheet and the Tailwind source bridge while sharing compact public fallbacks, so SessionChrome retains its complete default presentation without duplicating color formulas in application bundles.
- 5dfb93d: Let one Connected Machine agent retain and serve independent connections to multiple OpenGeni workspaces and deployments, with additive connection UX and connection-scoped runtime isolation.
- Updated dependencies [200586a]
  - @opengeni/sdk@0.47.1

## 0.47.0

### Minor Changes

- d8b9b71: Add opt-in container-responsive `ChatComposer` and `Composer.Root` layout, including source-container-aware portalled model and realtime menus while preserving viewport defaults.
- d8b9b71: Ship a ready-to-use, Preflight-free compiled CSS entry scoped to OpenGeni React roots, while retaining the Tailwind v4 bridge and CSS-free session surface.

## 0.46.6

### Patch Changes

- 43fa8f4: Expose authorized Codex Apps through the server-authoritative tool catalog and make setup recovery actionable without widening explicit session policies.
- 70ced80: Add an offline-safe Connected Machine enrollment removal lifecycle with credential revocation, durable audit history, guarded route and lease handling, SDK/MCP support, and accessible active-list reconciliation.
- Updated dependencies [70ced80]
  - @opengeni/sdk@0.46.6

## 0.46.5

### Patch Changes

- 43d45c6: Keep saved voice recordings on their original retry deadline during live UI renders, and normalize connector tool results whose optional structured payload is null without changing tool routing.
  - @opengeni/sdk@0.46.4

## 0.46.4

### Patch Changes

- b783f12: Keep optional MCP setup authentication out of unrelated chat timelines while preserving actionable tool-call reconnect events.
- 34c5cdb: Retain validated computer screenshots as authenticated, integrity-checked session artifacts with bounded event/history receipts, SDK range assembly, and React rendering while preserving historical inline-image compatibility.

  Fence screenshot cleanup and quota accounting across parent deletion, duplicate settlement, expiry, compensation, and garbage-collection races so provider objects are deleted only after durable lifecycle ownership and quota is released exactly once.

- 252095e: Keep durable composer voice recordings in automatic bounded recovery after transient failures, while requiring explicit insertion for every delayed or reload-recovered transcript.
- 4fd349d: Revoke attachment preview URLs on unmount even when React has not committed their attachment state yet.
- Updated dependencies [5d8bb99]
- Updated dependencies [34c5cdb]
  - @opengeni/sdk@0.46.4

## 0.46.3

### Patch Changes

- 800d091: Clear file attachments when their client or workspace changes, revoke outstanding preview URLs on unmount, fence late upload settlements from stale scopes, and reset Changes-tab virtualization measurements when a same-size diff is replaced.
- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- 23de73b: Add explicitly permissioned, audited plaintext reads for encrypted workspace variable-set values across REST, SDK, React, MCP, and UI surfaces.
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
  - @opengeni/sdk@0.46.3

## 0.46.2

### Patch Changes

- 5d1d0c2: Make browser live streams visibility-aware, share one routed session feed,
  bound reconciliation and heartbeat recovery, coalesce overlapping reads, and
  expose the append, publish, and SSE connection lifecycle in metrics.
- ce823ce: Replace first-party MCP mutation entity echoes with strict, versioned compact
  receipts; add bounded scheduled-task list/detail projections and preserve worker
  session references across receipt and legacy timeline results.
- Updated dependencies [5d1d0c2]
  - @opengeni/sdk@0.46.2

## 0.46.1

### Patch Changes

- 2bfbfcc: Keep compact desktop controls while giving mobile model, voice, navigation,
  composer, and session controls full-size touch targets.

## 0.46.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

### Patch Changes

- 5b6d36e: Use provider-reported usage rather than whole-request approximations for automatic context compaction, preserve provider-only input-token state across context rewrites, and label timeline counts as estimated conversation-history tokens.
- Updated dependencies [6eb0b23]
  - @opengeni/sdk@0.46.0

## 0.45.1

### Patch Changes

- ca7d125: Improve mobile touch targets and responsive session interactions across the React surfaces.

## 0.45.0

### Minor Changes

- 7faf6a9: Add a lossless `UserMessageBody` disclosure for very tall sent messages, including per-message expansion memory and timeline-owned scroll anchoring.

## 0.44.6

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
- Updated dependencies [69bc207]
- Updated dependencies [c0f8e40]
  - @opengeni/sdk@0.44.6

## 0.44.5

### Patch Changes

- 4e39d4d: Keep the Northstar demo's host font reset contained to embedded OpenGeni surfaces.

## 0.44.4

### Patch Changes

- 9159e64: Add render-compatible runtime typography and model-picker density tokens, a compact embedded preset, host-reset-safe component typography, and token propagation for portalled model and realtime menus.

## 0.44.3

### Patch Changes

- Updated dependencies [4502474]
  - @opengeni/sdk@0.44.3

## 0.44.2

### Patch Changes

- 2542ae0: Recover stale composer-draft OCC after tab sleep by recognizing DRAFT_CHANGED, soft-reloading on wake, and retrying autosave with the server revision while keeping local text.
- 2542ae0: Give progressive `tool_search` its own timeline card: capability query, disclosed tool leaves with source prefixes, and quiet no-match / failure states instead of the generic Done dump.

## 0.44.1

### Patch Changes

- e051404: Measure composer textarea height off-DOM so multi-line typing no longer collapses the live box and yanks tip-follow.
- 99e9b48: Give the realtime voice controls an accessible named group role.

## 0.44.0

### Patch Changes

- Updated dependencies [664c1d8]
  - @opengeni/sdk@0.44.0

## 0.43.1

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/sdk@0.43.1

## 0.43.0

### Patch Changes

- b6e39fc: Polish session chrome and apply_patch rendering; clarify realtime voice-end handoff.

  SessionChrome gets denser selected-chip UX and Codex function-tool apply_patch shapes render in the specialized diff UI. Solo goal_continuation machine-input rows are suppressed in favor of the GoalRow landmark. The realtime transcript-tail instruction now keeps in-flight work going after voice ends.

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/sdk@0.43.0

## 0.42.1

### Patch Changes

- Updated dependencies [4976e1c]
  - @opengeni/sdk@0.42.1

## 0.42.0

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/sdk@0.42.0

## 0.41.1

### Patch Changes

- abe0de6: Persist timesliced composer voice recordings in browser storage with reload-safe document ownership, opener/duplicate-tab fencing, oldest-first recovery, byte-ceiling enforcement, and durable transcript-before-draft handoff. Interrupted audio retries reuse the same recording, uncertain saved transcripts require explicit insertion instead of automatic retranscription or duplicate append, and transient handed-off cleanup failures are retried and garbage-collected owner-safely.
- Updated dependencies [abe0de6]
  - @opengeni/sdk@0.41.1

## 0.41.0

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/sdk@0.41.0

## 0.40.0

### Minor Changes

- a49692d: Publish the provider-neutral realtime controller and the exact OpenGeni realtime composer experience at `@opengeni/sdk/realtime` and `@opengeni/react/realtime`, including proxy-friendly client contracts, batteries-included existing/new-session controls, and the public reference demo.

### Patch Changes

- Updated dependencies [b121e7c]
- Updated dependencies [a49692d]
  - @opengeni/sdk@0.40.0

## 0.39.0

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/sdk@0.39.0

## 0.38.1

### Patch Changes

- d299c54: Keep captured-file actions legible and ensure the hosted voice-options control meets its minimum target size.

## 0.38.0

### Patch Changes

- 763aa97: Preserve a latency-mode selection made while a durable composer draft is loading.
- Updated dependencies [1d0f2ae]
- Updated dependencies [3e4842d]
  - @opengeni/sdk@0.38.0

## 0.37.0

### Minor Changes

- 1c49020: Publish the full model, reasoning-effort, and latency-mode picker used by the web app as a reusable, token-themed React component.

### Patch Changes

- Updated dependencies [13b961e]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [3baaebd]
  - @opengeni/sdk@0.37.0

## 0.36.2

### Patch Changes

- b4982fa: Expose GPT-5.6 Max reasoning end to end for managed and connected Codex models.
- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
  - @opengeni/sdk@0.36.2

## 0.36.1

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.
- Updated dependencies [9c4d73d]
  - @opengeni/sdk@0.36.1

## 0.36.0

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/sdk@0.36.0

## 0.35.3

### Patch Changes

- a299919: Make horizontally scrollable Markdown code blocks and tables reachable from the keyboard.

## 0.35.2

### Patch Changes

- 83ac3b6: Keep a malformed or unavailable timeline renderer from crashing the entire conversation by isolating each timeline group behind a visible fallback, then retry the row when its renderer inputs change.
  - @opengeni/sdk@0.35.0

## 0.35.1

### Patch Changes

- b286dad: Keep fleet-decision timeline rows mounted when unrelated session metadata, including personal pin state, changes.

## 0.35.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

### Patch Changes

- Updated dependencies [dd71248]
  - @opengeni/sdk@0.35.0

## 0.34.3

### Patch Changes

- ea344d6: Keep agent goal tools inside the activity cluster (no breakaway GoalRow split),
  allow collapsing live turn step shells, and keep densified Workspace hub /
  timeline disclosure changes under a stable Radix vendor chunk.

## 0.34.2

### Patch Changes

- 9840496: Avoid replacing an in-flight initial workspace-capture read when the matching capture announcement arrives first.

## 0.34.1

### Patch Changes

- Updated dependencies [408543f]
  - @opengeni/sdk@0.34.1

## 0.34.0

### Patch Changes

- Updated dependencies [ec0bc02]
- Updated dependencies [5a4c559]
  - @opengeni/sdk@0.34.0

## 0.33.1

### Patch Changes

- b5f2fb5: Keep live workbench acceptance aligned with the hosted controlled-panel contract and remove a real-time boundary from its related React regression coverage.
- Updated dependencies [8243ffe]
  - @opengeni/sdk@0.33.1

## 0.33.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- Updated dependencies [1ec9912]
  - @opengeni/sdk@0.33.0

## 0.32.1

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.
- 48ae722: Smooth tip-follow camera and streaming timeline motion (settle folds, tool enter, fence soft-close).
- Updated dependencies [c52acc0]
  - @opengeni/sdk@0.32.1

## 0.32.0

### Patch Changes

- Updated dependencies [f413e6c]
  - @opengeni/sdk@0.32.0

## 0.31.0

### Minor Changes

- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.

### Patch Changes

- b2e975f: Advance the merged knowledge release train to fresh publication identities without changing runtime behavior. This corrective source is derived from current main and does not reuse generated release output.
- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [b2e975f]
  - @opengeni/sdk@0.31.0

## Unreleased

- Copy affordances: fenced code + tables in `Markdown`, hover copy on user/assistant messages, and "Copy turn" on settled turn chips (includes the lifted final answer).
- Session timeline history navigation: `loadOldest` / `loadNewer` / `jumpToLatest` on `useSessionEvents`, plus Jump to start / Jump to latest chrome on `MessageTimeline` (bounded windows; no middle gap walk).
- Add `SessionChrome` — production/embed session-signal dock (incoming / queue / goal / agents) with token overrides (`--og-session-chrome-*`), token tooltips, crossfade panel switches, and queue hover actions wired to `UseTurnQueueResult`. Replaces stacked `QueueSurface` + host goal/agents chrome in the web session route.
- Export shared `Tooltip*` primitives used by SessionChrome (portal-token aware).
- Fix SessionChrome tooltips: inverted tip surface uses inline fg/bg so `.og-root` cannot blank the text; tip only icon actions; Steer copy matches QueueSurface (`Make this the next direction`).
- Light ChatComposer spacing/token freshen (quieter focus border, tighter footer/input padding).
- Replace host-adapter composer transcription with native MediaRecorder capture and immediate server transcription.
- Compact composer voice chrome: live/fallback waveform, separate cancel vs stop-and-transcribe actions, and a quieter transcribing state.

## 0.30.2

### Patch Changes

- 84fb671: Prevent a ready file restored during reconnect from being counted twice across the durable composer draft and the still-live attachment card. Canonical duplicate refs are removed before draft persistence and composer submission while custom mounts and exact draft revision/content conflict protection remain intact.
- 96eb64b: Advance the reviewed knowledge release package graph to fresh publishable identities after the previous version projection was invalidated. This changes release metadata only and does not alter runtime behavior.
- Updated dependencies [96eb64b]
  - @opengeni/sdk@0.30.2

## 0.30.1

### Patch Changes

- Updated dependencies [bbcbef5]
- Updated dependencies [ddff8db]
  - @opengeni/sdk@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [1f6f13f]
  - @opengeni/sdk@0.30.0

## 0.29.3

### Patch Changes

- 8dca209: Remove redundant success glyphs from collapsed turn summaries while preserving failed, cancelled, and active state indicators.
- 821f664: Seed shared session-event cursors from loaded history to prevent historical replay storms, and preserve the MCP SDK's exact request-timeout classification through safe transport-error sanitization.

## 0.29.2

### Patch Changes

- ad0bdc3: Surface managed-credit admission rejections with actionable composer recovery guidance while preserving drafts and attachments, and canonicalize default attachment mounts across established-session draft admission and replay.
  - @opengeni/sdk@0.29.0

## 0.29.1

### Patch Changes

- 8478e60: Default workspace-tracking sessions to every configured MCP server while
  preserving exact explicit API allow-lists. Keep OpenGeni's internal carrier and
  default-on Files surface out of the web picker's visible choices and counts.
  Settle provider-native web searches from their own terminal status, render each
  web action truthfully, keep completed searches before the answer they informed,
  and hide unresolved private citation handles from the human timeline.

## 0.29.0

### Patch Changes

- Updated dependencies [33dc88f]
  - @opengeni/sdk@0.29.0

## 0.28.3

### Patch Changes

- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.
- Updated dependencies [28c678d]
- Updated dependencies [1c4018e]
  - @opengeni/sdk@0.28.3

## 0.28.2

### Patch Changes

- c1dcccc: Publish the current client surfaces from one exact reviewed source revision.
- Updated dependencies [c1dcccc]
  - @opengeni/sdk@0.28.2

## 0.28.1

### Patch Changes

- 2ec6494: Publish the current client surfaces from one exact reviewed source revision.
- Updated dependencies [2ec6494]
  - @opengeni/sdk@0.28.1

## 0.28.0

### Minor Changes

- 29ad09b: Persist typed machine inputs into canonical model history at turn claim, expose
  authoritative pending-input queue projections and lifecycle events, render
  delivered batches in the timeline, and preserve append-only prompt-cache
  prefixes across tools, later turns, recovery, and explicit compaction.

### Patch Changes

- 8eaa377: Add per-timeline `add`, `remove`, and `replace` customization for collapsed turn summary facets while preserving the existing defaults.
- 8eaa377: Expose transport-tolerant MCP output normalization from the SDK and reuse it in the React timeline parser.
- Updated dependencies [29ad09b]
- Updated dependencies [8eaa377]
- Updated dependencies [dfc3235]
  - @opengeni/sdk@0.28.0

## 0.27.0

### Patch Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.
- Updated dependencies [519d93c]
  - @opengeni/sdk@0.27.0

## 0.26.3

### Patch Changes

- Updated dependencies [110bb77]
  - @opengeni/sdk@0.26.3

## 0.26.2

### Patch Changes

- f92af07: Give each session-only React hook an exact structural client contract so embedded hosts can use session reads, goals, lineage, file attachments, structured human input, and MCP approval policies without implementing unrelated composer, queue, workspace, or workbench APIs.

## 0.26.1

### Patch Changes

- ffd246c: Keep workspace-capture Git status, diffs, and untracked files below provider retained-output limits, and publish an explicit degraded revision instead of an authoritative empty diff when repository reads fail.
- Updated dependencies [ffd246c]
  - @opengeni/sdk@0.26.1

## 0.26.0

### Patch Changes

- Updated dependencies [06a5801]
- Updated dependencies [5511c24]
  - @opengeni/sdk@0.26.0

## 0.25.5

### Patch Changes

- 6f0690d: Preserve persisted tool-call correlation and bounded truncation telemetry when loading timeline history.
- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
  - @opengeni/sdk@0.25.5

## 0.25.4

### Patch Changes

- 5846352: Keep the session-only React entry provider-free by resolving session hooks through the session context, preserving the exclusion of provider and workbench dependencies.

## 0.25.3

### Patch Changes

- a0f2442: Return typed correlation-safe API failures, discard bounded non-JSON gateway bodies in the SDK, preserve retryability and ambiguous mutation outcomes, and keep composer drafts stable across transient failures and live policy rerenders.
- Updated dependencies [a0f2442]
  - @opengeni/sdk@0.25.3

## 0.25.2

### Patch Changes

- Updated dependencies [85cb323]
  - @opengeni/sdk@0.25.2

## 0.25.1

### Patch Changes

- 9db6c17: Prevent live session and policy rerenders from repeatedly fetching the same composer draft while preserving target, explicit, and event-driven reloads.
  - @opengeni/sdk@0.25.0

## 0.25.0

### Patch Changes

- c549ed8: Persist and transactionally materialize revisioned active-goal continuation
  obligations, recover their Temporal delivery without human input or model
  polling, preserve authoritative human/Steer ordering, and expose truthful
  scheduled, running, blocked, and invariant-broken continuation state to clients.
  Make agent goal updates revisioned, attempt-recoverable commands so ambiguous
  commit responses reconcile without duplicate mutation or stale overwrites.
- 860de22: Persist actor-private pre-session drafts on the server, consume only the exact accepted revision after durable session initialization, return structured create errors, deduplicate create resources, derive checksums for SDK uploads, restore finalized attachments without browser-local byte authority, and preserve attachments added while an earlier send is in flight.
- Updated dependencies [c549ed8]
- Updated dependencies [46bac05]
- Updated dependencies [860de22]
- Updated dependencies [5b57a2d]
  - @opengeni/sdk@0.25.0

## 0.24.0

### Minor Changes

- 0ed0f01: Add per-member session pin preferences with isolated server persistence, bounded/reused stable
  pagination snapshots, snapshot-free pin polling, typed SDK and React reconciliation, and accessible
  list and header controls.

### Patch Changes

- 744a93d: Add default-off, bounded adaptive Codex fleet decision telemetry with strict deterministic replay, cache-aware and work-conserving policy simulation, secret-safe event/UI observability, and independent future policy gates.
- Updated dependencies [744a93d]
- Updated dependencies [0ed0f01]
  - @opengeni/sdk@0.24.0

## 0.23.0

### Minor Changes

- 0d60720: Add capability-first session tool policies with omission-as-discovery defaults,
  explicit per-turn narrowing and child inheritance, secret-safe effective-policy
  projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
  worker, embedding, and audit contracts.

  Harden credential-bearing MCP and OAuth traffic with destination-bound
  credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
  results, request and response bodies, and independently validated manual
  redirects. Extend renewable, session-bound Toolspace access to connected
  machines while dynamically fencing every call to the session's active attempt.

### Patch Changes

- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
- Updated dependencies [3214d70]
  - @opengeni/sdk@0.23.0

## 0.22.1

### Patch Changes

- Updated dependencies [524599e]
  - @opengeni/sdk@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies [229902b]
  - @opengeni/sdk@0.22.0

## 0.21.2

### Patch Changes

- Updated dependencies [4966649]
  - @opengeni/sdk@0.21.2

## 0.21.1

### Patch Changes

- bd46c89: Mount long session timelines progressively so the newest activity paints first and low-end browsers remain responsive while older groups hydrate.
- Updated dependencies [ff23da5]
  - @opengeni/sdk@0.21.1

## 0.21.0

### Minor Changes

- d1dee7a: Let embedding hosts read and update an existing session MCP server's approval
  policy through the public API, SDK, and React session hook. Each claimed
  attempt freezes its policy under the session lock, so updates affect the next
  attempt without reinterpreting work already running; model MCP and
  Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
  side-effect receipts bind every proxied call to the exact active attempt, so
  Pause, Steer, recovery, and late outputs preserve one authoritative owner.

### Patch Changes

- Updated dependencies [d1dee7a]
  - @opengeni/sdk@0.21.0

## 0.20.0

### Minor Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.

### Patch Changes

- Updated dependencies [9f84cc9]
  - @opengeni/sdk@0.20.0

## 0.19.0

### Minor Changes

- 3aee519: Add a workspace-accepted, provider-agnostic transcription policy and host-adapter contract, plus an accessible composer microphone that keeps partials ephemeral and appends non-empty accepted finals to the editable draft exactly once. Policies explicitly accept automatic language detection and speaker diarization, events can carry strict neutral result metadata, pending starts and cleanup are abortable/bounded, and adapter failures stay behind controlled UI copy with redacted non-UI diagnostics.

### Patch Changes

- 136227e: Add an immutable, versioned curated skill library with explicit workspace selection and inspectable provenance, and preserve WCAG AA contrast for dark-theme primary actions.
- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/sdk@0.19.0

## 0.18.0

### Minor Changes

- 5547b2f: Let embedders allowlist Changes, Files, Terminal, and Desktop workbench surfaces while keeping disabled surfaces behaviorally dormant.
- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
- c389adc: Add a provider-neutral host run-credential port with frozen turn/session lineage,
  off-manifest environment and file generations, proactive renewal, attempt-safe
  cleanup with bounded generation retention, output redaction hints, and structured
  reconnect UI support. Hosts can explicitly opt a frozen target out, and the
  POSIX materializer supports both Linux `flock` and a portable directory-lock
  fallback with cross-platform base64 decoding.
- a11a7fc: Support mixed GitHub, GitLab, and Azure DevOps repositories—including multiple
  accounts or installations for one provider—in a single session through bounded,
  host-opaque credential bindings and optional read/write access intent.

  Validate binding/provider/host echoes before token injection, isolate tokens in
  hashed binding files, select Git credentials by remote path, fail provider CLIs
  closed on ambiguous bindings, and renew each binding independently while keeping
  legacy one-binding-per-provider request and file aliases compatible.

- 2dfd415: Let embedders keep composer drafts in local React state while leaving message, attachment, steer, and control behavior active. Queue checkout is withheld because its atomic API contract necessarily creates a durable composer draft.
- dda6398: Add durable structured human-input tool calls with exact-turn ownership,
  answer/skip/expiry/cancellation outcomes, restart-safe Temporal resumption,
  authorized API and SDK methods, and headless plus styled React embed surfaces.

### Patch Changes

- 4498714: Preserve tool names and arguments when projecting serialized approval items through the session-only React API.
- 51f45a3: Publish the session-only React entry point and typed session control surface in a stable registry release.
- 44ff327: Fence queue, composer, and control hook state to the active workspace and session so target switches cannot expose or accept stale private state.
- Updated dependencies [1fcd83d]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [51f45a3]
- Updated dependencies [dda6398]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/sdk@0.18.0

## 0.17.0

### Minor Changes

- 717a7ef: Add a headless chat-composer controller, compound composer primitives, and typed message overrides while preserving `ChatComposer` as the default preset.
- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

### Patch Changes

- bb09be8: Add a session-only React entrypoint and mirror MCP approval policy in
  the public SDK type.
- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- Updated dependencies [bb09be8]
- Updated dependencies
- Updated dependencies [dbb6232]
  - @opengeni/sdk@0.17.0

## 0.16.1

### Patch Changes

- 4e9c48c: Preserve the exact autosaved composer text when sending or steering so trailing whitespace cannot trip the draft consistency fence.
- 9a7dec2: Keep captured workspace files and diffs usable when the live sandbox provider is temporarily unavailable, surface a truthful retryable degraded state, and distinguish provider failures from invalid workspace paths.

## 0.16.0

### Minor Changes

- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- Updated dependencies [ec0697a]
  - @opengeni/sdk@0.16.0

## 0.15.0

### Minor Changes

- f42cd4a: Replace the old queue and interruption surface with one revisioned prompt queue, durable composer drafts, atomic Steer, recursive Pause/Resume, workspace control invalidation, stale-client contract fencing, and a shared accessible queue UI for first- and third-party consumers. Remove the obsolete passive child-notification setting so every child terminal result follows the one bounded, coalescible internal-update contract.
- 0399277: Add a per-machine telemetry detail view and upgrade the machine cards. The card now leads with a fused health verdict (connection + resource pressure + sample freshness), previews a CPU trend, and shows live freshness; opening a card reveals full metric history (CPU, memory, disk, load, GPU) over 15m/1h/6h/24h with threshold guides and a hover crosshair — rendering the downsampled series the API already served but nothing consumed. Resource meters now read as a coherent green/amber/red traffic-light aligned with the health verdict, and load average renders neutral (it is not core-normalized) with the run queue carrying the real saturation signal.

### Patch Changes

- 215d01d: Render normalized persisted MCP text outputs in custom timeline tool cards.
- Updated dependencies [f42cd4a]
  - @opengeni/sdk@0.15.0

## 0.14.0

### Minor Changes

- dc79905: Harden the workspace dock with persistent tab state, authoritative live-versus-capture defaults, accessible mobile navigation, guarded-file routing, and deterministic browser acceptance coverage.

## 0.13.0

### Patch Changes

- 7a7126d: Fence session events, workspace capture, file tree, git state, warm intents, and tab latches by session identity; bound signed-manifest fetches; refresh same-shape diffs when hunk content changes; and clear stale file metadata during reconciliation.
- ad4502a: Make the workbench and console dependency-safe, keep list identities stable, preserve caught error causes, isolate desktop consent tests from real transports, and enforce warning-free repository lint plus aggregate React tests in CI.
- 04d7595: Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- fbf029c: Make the workspace dock usable on narrow and touch surfaces: replace the cramped two-column diff with an identity-stable changed-file picker, preserve selection across reordered captures, provide accessible target sizes for dock and file controls, and raise text/diff contrast to WCAG 2.2 AA.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- e4d3569: Add per-member workspace session pins with stable pinned-first listing, subject-scoped FORCE-RLS persistence, snapshot-backed activity pagination, optimistic OCC-safe pin/unpin updates, and accessible responsive web controls.
- 810542f: Commit workspace capture announcements atomically with their revision rows and keep harmless late capture bookkeeping out of the user timeline.
- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- Updated dependencies [ad4502a]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [e4d3569]
- Updated dependencies [a5f58f9]
  - @opengeni/sdk@0.13.0

## 0.12.0

### Minor Changes

- f0ce46c: Credit exhaustion renders as a first-class failure with a top-up CTA (was: silent idle). A budget-exhausted `turn.completed` (`segmentLimit: "budget_exhausted"` / `detail: "insufficient OpenGeni credits"`) now projects as a failed turn-end plus a failed notice instead of a clean completed turn, and `turn.failed` credit errors collapse to one canonical sentence via `humanizeFailureReason`. New exports: `isCreditExhaustion`, `creditExhaustedFromEvents`, and `CREDIT_EXHAUSTION_MESSAGE`. The web console (unversioned app) rides along: a credit-specific banner with an "Add credits" link to organization settings — shown also on idle sessions whose last turn died of budget exhaustion — replacing the "send a message to revive" copy that cannot work without credits.

## 0.11.0

### Patch Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

- Updated dependencies [602db89]
  - @opengeni/sdk@0.11.0

## 0.10.0

### Minor Changes

- 7bfe593: Surface the desktop-capture-blocked reason as server-visible enrollment state.

  A machine can have a display it cannot CAPTURE (macOS Screen Recording / TCC not granted). The agent's connect Hello already withholds the desktop cell in that case; this persists a human, actionable reason alongside it so the Machines dashboard / VM picker can render "display: capture not granted" instead of a bare `display_unavailable`.

  - **Contracts / SDK**: `MachineView` (and `EnrollmentSummary`) gain an additive, nullable `desktopUnavailableReason`. Non-null only when a display exists but capture is blocked; `null` == capture permitted OR genuinely headless. Absent/`null` ⇒ byte-identical to today's shape for existing consumers.
  - **DB**: new nullable `enrollments.desktop_unavailable_reason` column (no backfill — `NULL` preserves the existing "capture-permitted or headless" semantics). The display-cursor writer now persists `has_display` AND the reason together, change-guarded on either field, and self-heals to `null` on the next Hello once the grant is restored.

- 351665b: Completed activity clusters of a still-running turn now fold behind neutral chips (facets + a quiet pulse dot; no verdict glyph — the turn has none yet), keeping only the live tail expanded. This bounds the DOM of very long autonomous turns the same way settled folding bounds history; on settle, everything collapses into the single turn fold as before. TurnSummary's `outcome` prop is now optional (absent = in-progress cluster).

### Patch Changes

- 550b055: Fresh-eyes review fixes: sandbox command output uses its canonical `chunk` wire field end-to-end — the projection and the compact coalescer previously read only legacy `text`/`output`, so compact history windows dropped terminal output entirely (and the resume cursor skipped the raw events that carried it); coalesced sandbox runs now also break on stream and commandId so stdout/stderr never merge. Live-cluster folding is re-based on the true invariants: a cluster with running/streaming items never folds, and folding happens only when the NEXT group is agent progress (activity/turn/narration) — so a pending queued message or an approval pause no longer folds the work the reader needs in view.
- Updated dependencies [7bfe593]
  - @opengeni/sdk@0.10.0

## 0.9.1

### Patch Changes

- ea8757a: The timeline projection's event-grammar contract is now pinned by a golden fixture suite (8 realistic event-log fixtures → committed projection snapshots, including compact/raw equivalence and legacy/malformed tolerance). Intentional grammar changes regenerate snapshots so the diff is reviewed; unintentional ones fail CI.
  - @opengeni/sdk@0.9.0

## 0.9.0

### Patch Changes

- 445fb78: First paint of a session is now a single compact fetch (deeper history loads via the scroll sentinel), and the hook exposes `initialLoading` so hosts can suppress genesis fallbacks while the tail window is still fetching — on large sessions the web console painted the session's initial message at the top for the whole fetch.
- Updated dependencies [e513236]
  - @opengeni/sdk@0.9.0

## 0.8.0

### Patch Changes

- 3d708b5: Add compact event replay support for history windows and switch React session-event loading to capped compact pages with coalesced-delta resume cursors.
- Updated dependencies [3d708b5]
  - @opengeni/sdk@0.8.0

## 0.7.0

### Minor Changes

- 5e56bcd: Add tail-first session event loading with reverse durable pagination, older-history loading controls, and timeline props for smooth prepend pagination.

### Patch Changes

- 068c647: A no-op pinned-follow scroll assignment left the programmatic-scroll mark set (no scroll event fires to consume it), which made the reader's next real scroll-up read as programmatic and get eaten — the view snapped back to the bottom and upward backfill could never engage. The mark now self-clears when an assignment doesn't move the scroller.
- d84eef8: Session load and backfill no longer flicker: the timeline stays invisible until its first bottom-anchored frame (a flash of the window top is structurally impossible), rows decide at mount whether they animate so bulk paints never replay entrance animations across the timeline, the scroller disables native browser scroll anchoring (it fought the reader-anchor corrections during backfill), and programmatic scroll echoes can no longer unpin the bottom-follow (which could strand the view just short of the bottom).
- Updated dependencies [15deca0]
- Updated dependencies [5e56bcd]
  - @opengeni/sdk@0.7.0

## 0.6.3

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/sdk@0.6.3

## 0.6.2

### Patch Changes

- a63bc1f: Anchor queued user messages at the turn that actually executes them in the timeline projection, show still-pending queued messages quietly, and ignore cancellation events for queued turns that never started.

## 0.6.1

### Patch Changes

- d935316: The timeline no longer renders queued / running / idle status dividers — they are machinery telemetry the header pill, live shimmer, and turn-chip duration facet already carry. Only attention-worthy statuses (requires_action, failed, cancelled) still earn a divider. Applies retroactively to historical traces since the filter lives in the pure projection.

## 0.6.0

### Minor Changes

- a4f370f: Carve the connected-machine UI into a dedicated `@opengeni/react/machines` subpath, and add `workingDir` to the SDK create-session request.

  - **`@opengeni/react`**: the bring-your-own-compute surface (`useMachines`, `MachinesDashboard`, `MachineCard`, `MachineDockBar`, `SharedMachineDisclosure`, `MachineStatusPill`, `ConnectionStatusPill`, `ConnectionDot`, `MachineMetrics`, `EnrollmentDeviceFlow`, `EnrollmentConsent`, `connectionStatusForState`, and the `MachineView` / `MachineState` / `MachineKind` / `MachinesResponse` / `MetricSample` view-model types) now lives at `@opengeni/react/machines`. The root keeps re-exporting it for backwards compatibility — **non-breaking** — but the root re-export is **deprecated** and will move in a future major. Import from `@opengeni/react/machines` going forward.
  - **`@opengeni/sdk`**: `CreateSessionRequest` gains an optional `workingDir?: string` field — the host working directory for a connected-machine target (the agent runs there; defaults to the machine's launch dir). Ignored for managed sandboxes.

- d9d7743: Render the self-hosted desktop stream: a PNG-frame canvas client for `transport: "relay-frames"`.

  Self-hosted machines stream their desktop as PNG-per-frame protobuf datagrams over the relay (not RFB), so the noVNC/RFB viewer could never render them — the desktop went "warm" but the live stream never came up. This adds `useRelayFrameStream`, a view-only canvas renderer that opens the relay channel, decodes each PNG frame, and paints it (latest-wins backpressure so a slow decode never queues). `useDesktopStream` now dispatches on `DesktopStream.transport`: `"vnc-ws"` → noVNC (Modal boxes), `"relay-frames"` → the frame renderer (self-hosted machines). The `DesktopStream.transport` / `client` unions gain `"relay-frames"` / `"frames"`. View-only in v1 (matches the machine's read-only mode); interactive input is a follow-up.

- ccebacd: Completed, failed, and cancelled turns now fold their activity behind a TurnSummary chip in MessageTimeline, with failed turns starting expanded so their failure text remains visible.
- 5a289d0: Settled turns now collapse the entire turn span behind one summary chip, leaving only the final agent message visible until expanded. Expanding the chip reveals mid-turn narration and nested per-cluster activity summaries.

### Patch Changes

- Updated dependencies [a4f370f]
- Updated dependencies [d9d7743]
  - @opengeni/sdk@0.6.0

## 0.5.0

### Minor Changes

- 48c0d2e: Add session titles. A session now has a short display title that the agent generates itself: on the genesis turn a hidden, non-persisted directive asks the agent to call the new `set_session_title` tool, so the session is named on its own model with no extra LLM call. Users (and agents with `sessions:control`, via `set_other_session_title`) can rename; a user-set title is permanent and is never clobbered by agent writes.

  - `@opengeni/contracts`: `Session.title` / `Session.titleSource`, `UpdateSessionRequest`, and the `session.title_set` event.
  - `@opengeni/sdk`: `client.updateSession(workspaceId, sessionId, { title })`.
  - `@opengeni/react`: `useSession().updateTitle(...)`, live `session.title_set` handling, and `sessionDisplayTitle` now prefers `session.title`.

### Patch Changes

- Updated dependencies [48c0d2e]
  - @opengeni/sdk@0.5.0

## 0.4.0

### Minor Changes

- a1c82c5: Add the world-class timeline tool-call renderer module and the sandbox workspace client surface to `@opengeni/react`.

  - **Timeline renderers**: per-tool disclosure cards (full-row toggle, keyboard-accessible), screenshots → lightbox, theme-aware Pierre diffs, turn-collapse summary chips, sub-agent worker/goal landmarks, a consumer-extensible tool registry, and complete state handling (running / complete / failed / cancelled), each with its own affordance.
  - **Sandbox surfacing**: file/terminal/git/desktop hooks and components (`useSandboxFiles`, `useSandboxTerminal`, `useSandboxGit`, `useDesktopStream`, `useTerminalStream`, `useSessionCapabilities`, `SandboxFiles`, `SandboxTerminal`, `DesktopViewer`, `WorkspaceDock`, Pierre diff/file views, `CodeEditor`).

  All additive; `MessageTimeline`'s `items` contract is unchanged. The internal `compactPayloadPreview` helper was removed from the public surface.

### Patch Changes

- Updated dependencies [2989163]
- Updated dependencies [a1c82c5]
  - @opengeni/sdk@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [a78a09b]
  - @opengeni/sdk@0.3.1

## 0.3.0

### Minor Changes

- daaffd7: Chat `MessageTimeline` now renders message bodies as **markdown by default** (react-markdown + remark-gfm, themed to the `og-*` design tokens — headings, lists, GFM task lists, inline/fenced code, blockquotes, tables, links). The `renderMessageText` prop still overrides the default renderer.

## 0.2.0

### Minor Changes

- 21c1535: Initial public release of the OpenGeni client packages.

  - `@opengeni/contracts`: shared zod wire-contract schemas and types.
  - `@opengeni/sdk`: zero-dependency, framework-agnostic TypeScript client with typed API, session lifecycle, and SSE streaming (reconnect + replay-by-sequence).
  - `@opengeni/react`: React hooks and styled components built on `@opengeni/sdk`.

  All three now ship ESM + `.d.ts` builds via tsup and are published to npm with provenance.

### Patch Changes

- Updated dependencies [21c1535]
  - @opengeni/sdk@0.2.0
