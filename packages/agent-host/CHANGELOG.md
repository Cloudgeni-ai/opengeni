# @opengeni/agent-host

## 6.22.0

### Patch Changes

- aff49c5: The agent ships the embedded browser controller whose browser checkpoints leave sites' service worker caches behind, so pausing and resuming a managed browser for a large web app moves a few MB instead of hundreds.
- 3bf1c71: A Connected Machine command's completion no longer reaches its session minutes late on a slow uplink. The agent sent the few-byte completion notice, its retries and its operation inventory through the same first-in-first-out connection as command output, so the notice waited behind every output frame already queued (or was dropped from a full queue) until the next reconnect. The agent now sends them on its control connection, repeating an unacknowledged completion with every heartbeat. Opengeni's collector also used to give up on a completed command's output after five seconds without it, attach again (queuing the same frames once more) and back off for up to five minutes; it now follows one attachment until the exit arrives or its claim budget ends. `replayConnectedCommandOutput` requires a deadline for terminal replays. Failed completion, inventory collection, probe, settlement and output release warnings now carry a closed `reason` code (`claim_deadline`, `exit_frontier_not_reached`, `exit_frontier_mismatch`, `output_transport_unavailable`, `control_<code>`, `database_<sqlstate>` or `unclassified`), exported by the new `connectedCommandFailureReason`, since telemetry does not export error text.
- Updated dependencies [d50092b]
  - @opengeni/sdk@6.22.0

## 6.21.0

### Patch Changes

- Updated dependencies [ef4c334]
- Updated dependencies [6ac2cd4]
  - @opengeni/sdk@6.21.0

## 6.20.1

### Patch Changes

- @opengeni/sdk@6.20.1

## 6.20.0

### Patch Changes

- Updated dependencies [c624443]
- Updated dependencies [e37485b]
  - @opengeni/sdk@6.20.0

## 6.19.0

### Patch Changes

- 65cb26f: Agent 0.1.161 ships the embedded browser controller that relaunches a managed browser whose process was killed while the controller was stopping, instead of refusing it permanently.
- 227650c: A Connected Machine update the server stops hearing about no longer stays stuck. An update outlives the connection its request arrived on, since each connection lasts only as long as its five-minute broker credential, but the agent sent its progress through that connection, so progress after it closed could be lost: a failed or still-waiting update could read as `waiting_for_idle` with no blockers for good, on the release promoted back then, and the server never asked again because an accepted update was the agent's to finish. The agent now reports update progress through its current connection. The server treats an unfinished update it has not heard about for 30 minutes (an unanswered request after 10) as lost, and the next heartbeat, or Update now, replaces it with a request for the release promoted now. An agent still carrying the old update refuses it as busy updating and is asked again later. `beginEnrollmentAgentUpdate` takes an optional `replaceUnfinishedBefore` for this.
- Updated dependencies [a85adef]
  - @opengeni/sdk@6.19.0

## 6.18.0

### Patch Changes

- bd21ead: A finished command no longer keeps a file descriptor open while the agent holds its output. When a command's output spills to disk, the agent kept the spool segment's append handle open until the output was released or evicted, so every completed command waiting for its final acknowledgement held one descriptor. Retained results can number in the thousands, which a 1024 soft limit can't cover. A busy sandbox then hit `EMFILE` and couldn't start `/bin/sh` for new commands. Writing the command's exit record now closes the handle, and reads open their own as before. Running commands are unchanged.
- Updated dependencies [f313a0e]
- Updated dependencies [6813960]
- Updated dependencies [9188c1d]
- Updated dependencies [3105a8b]
- Updated dependencies [a16189c]
  - @opengeni/sdk@6.18.0

## 6.17.0

### Patch Changes

- Updated dependencies [43aa19d]
- Updated dependencies [deccb54]
- Updated dependencies [389de66]
- Updated dependencies [42ef2a2]
- Updated dependencies [241ce71]
  - @opengeni/sdk@6.17.0

## 6.16.0

### Patch Changes

- Updated dependencies [86e5358]
  - @opengeni/sdk@6.16.0

## 6.15.0

### Patch Changes

- Updated dependencies [708848c]
- Updated dependencies [60d067d]
- Updated dependencies [f92ff08]
- Updated dependencies [060c983]
- Updated dependencies [bf804ef]
- Updated dependencies [6a5023d]
- Updated dependencies [02ac654]
- Updated dependencies [b0fce89]
- Updated dependencies [9885d37]
- Updated dependencies [7a83f9b]
  - @opengeni/sdk@6.15.0

## 6.14.0

### Patch Changes

- Updated dependencies [c976c87]
- Updated dependencies [904eae7]
- Updated dependencies [7c926f8]
  - @opengeni/sdk@6.14.0

## 6.13.0

### Patch Changes

- Updated dependencies [1c7aa2a]
  - @opengeni/sdk@6.13.0

## 6.12.0

### Patch Changes

- Updated dependencies [64fd53f]
- Updated dependencies [2e7c01e]
- Updated dependencies [281af3a]
- Updated dependencies [e9222e0]
- Updated dependencies [8cc1ddd]
- Updated dependencies [98938f0]
- Updated dependencies [3929153]
- Updated dependencies [2e1e9c6]
- Updated dependencies [2e749ad]
- Updated dependencies [fcdf7de]
- Updated dependencies [bee1e4c]
- Updated dependencies [65e1fb9]
- Updated dependencies [c0b9f88]
  - @opengeni/sdk@6.12.0

## 6.11.0

### Patch Changes

- cd52481: A command's `kill -1` no longer takes a Linux Connected Machine agent offline. `kill -1` signals every process of the user, so the agent stopped, and a foreground agent's keeper stopped it for good. The agent now keeps running when one of its own commands sends it `SIGTERM` or `SIGINT`, including from a short-lived sender that already exited while a command was running or had just ended. The keeper ignores stop signals from the agent's commands, lets the agent decide about senders that already exited, and starts again an agent such a signal ended (`SIGHUP`, `SIGQUIT`, `SIGUSR2`). Nothing is blocked: the command still receives every signal, and the service manager, the desktop app, Ctrl-C, `opengeni-agent stop` or a `kill` from a shell outside the agent's commands still stop it. On Windows each command now runs on a hidden console of its own, so a Ctrl-C event a command sends to its whole console no longer stops the agent. `kill 0` and `kill -<group>` already reached only the command's own process group; a new test keeps it that way.
- d677983: A workspace root or home folder that the machine agent (0.1.155) creates again is now complete before any command can start in it. Before, the folder appeared first and got its owner and mode afterwards, so a command racing to start there could begin in a folder still owned by the agent with the agent's umask mode. If the agent couldn't give a run-as user's home to that user, it left that half-made folder behind, and the command ran in it. On Linux and macOS the agent now makes the folder under a private name, sets its owner and mode, and moves it into place without replacing anything. If the owner can't be set, the agent removes it and that one command fails as not found. When the agent can't make a missing folder again, that not-found error now also says why, for example "(it was missing and creating it again failed: Permission denied (os error 13))". On macOS, the developer-tools check behind the Git identity probe now also uses the agent's retained `/dev/null`, so it keeps working when `/dev/null` was removed.
- 42cd370: When the separately installed Opengeni Agent runs this computer, the desktop app now reports which machine it is in the workspace. Its status left the enrollment out in that case, so Settings › Computer use could not find the computer in the machine list and showed screen control and Chrome as Off while agents were using both, and the Runs on menu did not mark the computer as "This computer". The app-run case already reported it.
- Updated dependencies [9bb1b56]
- Updated dependencies [7e92bda]
- Updated dependencies [71395d6]
- Updated dependencies [d8e2bbc]
- Updated dependencies [a505ce8]
- Updated dependencies [840a780]
- Updated dependencies [9d52126]
- Updated dependencies [2a02889]
- Updated dependencies [888aaf5]
- Updated dependencies [d96bc4d]
- Updated dependencies [7ab60df]
- Updated dependencies [e10e748]
- Updated dependencies [1b8dc89]
- Updated dependencies [7d86f8b]
- Updated dependencies [3f64150]
- Updated dependencies [486e0bf]
- Updated dependencies [cd349e6]
- Updated dependencies [ba482ea]
- Updated dependencies [6abf872]
- Updated dependencies [b1b8f58]
- Updated dependencies [6d81049]
- Updated dependencies [57748cf]
- Updated dependencies [3b81d9b]
- Updated dependencies [d355388]
- Updated dependencies [d8e2bbc]
- Updated dependencies [b9523c1]
- Updated dependencies [cf9358a]
  - @opengeni/sdk@6.11.0

## 6.10.0

### Patch Changes

- b72f388: A Connected Machine agent on Linux now comes back however often it is stopped. Its systemd unit allowed five starts a minute, so a few quick kills (a command such as `pkill -f opengeni` run in a loop, or a model retrying one) left the agent stopped until the person started it by hand. The unit now has no start limit and restarts the agent after 2 s, backing off to 30 s (systemd 254 and newer; older systemd keeps a fixed 5 s). An installed unit the agent generated is updated when the agent starts after upgrading, without restarting the agent; a unit someone edited is left alone. The macOS LaunchAgent and the Windows logon task already kept restarting the agent and are unchanged.
- 6900fce: The native Codemode client on Connected Machines (`opengeni-agent codemode`, the `$OPENGENI_CODEMODE_NATIVE_CLIENT` path) now says why it can't reach Opengeni instead of "Codemode request failed: error sending request for url (…)". A failed DNS lookup names the host, the resolver's reason and where to look; a TLS certificate that is not yet valid or has expired names this machine's clock reading, so a wrong clock is easy to spot; a certificate for another name points at the URL and intercepting proxies; a refused, timed-out, closed or unroutable connection says so. When a proxy from `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` is in use, connection failures name the proxy (host and port only) and its variable instead of blaming Opengeni's host or the resolver, and a failure while an answer was arriving reads "Lost contact with Opengeni". A connection that is not up within 10 seconds now fails as a connection timeout instead of waiting out the 30-second request limit. The machine's own settings are never changed: on a person's own computer the message says what to check. Unknown causes keep the previous text. Takes effect with the next machine agent release (0.1.151).
- Updated dependencies [c9e5547]
- Updated dependencies [1fd358c]
- Updated dependencies [fb37d99]
- Updated dependencies [f619179]
- Updated dependencies [15763a2]
- Updated dependencies [e551a50]
- Updated dependencies [f45ab2f]
- Updated dependencies [9cf9b58]
- Updated dependencies [d717b72]
  - @opengeni/sdk@6.10.0

## 6.9.0

### Patch Changes

- Updated dependencies [f1c6437]
- Updated dependencies [8572155]
- Updated dependencies [54bf495]
  - @opengeni/sdk@6.9.0

## 6.8.0

### Patch Changes

- Updated dependencies [feaecf8]
  - @opengeni/sdk@6.8.0

## 6.7.0

### Patch Changes

- Updated dependencies [c08233e]
- Updated dependencies [cb37e4d]
- Updated dependencies [0d04cf4]
- Updated dependencies [cf35731]
  - @opengeni/sdk@6.7.0

## 6.6.0

### Patch Changes

- Updated dependencies [fb49abf]
- Updated dependencies [2c76a2a]
- Updated dependencies [09bc485]
- Updated dependencies [3cb05f9]
  - @opengeni/sdk@6.6.0

## 6.5.1

### Patch Changes

- Updated dependencies [7a9c492]
- Updated dependencies [e4484f1]
- Updated dependencies [7f3d037]
- Updated dependencies [f4f82c0]
- Updated dependencies [317fb4d]
- Updated dependencies [033cd63]
- Updated dependencies [b18bd6c]
- Updated dependencies [83ccc2b]
- Updated dependencies [da9b7e5]
- Updated dependencies [0f7f559]
- Updated dependencies [0f7f559]
- Updated dependencies [de8fc61]
- Updated dependencies [dd7759c]
- Updated dependencies [4682263]
- Updated dependencies [52c8c3b]
- Updated dependencies [abb4af1]
- Updated dependencies [86e35f1]
- Updated dependencies [0f7f559]
  - @opengeni/sdk@6.5.0

## 6.4.0

### Patch Changes

- Updated dependencies [92f419c]
- Updated dependencies [bc5c6d5]
- Updated dependencies [b4e780e]
- Updated dependencies [ace882b]
- Updated dependencies [dcb2352]
- Updated dependencies [f3e6835]
- Updated dependencies [0b19c29]
- Updated dependencies [b098518]
- Updated dependencies [a853c7a]
- Updated dependencies [a99a7d6]
- Updated dependencies [c2f978b]
- Updated dependencies [c59d7f8]
- Updated dependencies [237329e]
- Updated dependencies [bf3cf84]
- Updated dependencies [d55f740]
- Updated dependencies [0d409a7]
- Updated dependencies [cf9415d]
- Updated dependencies [4bd54f1]
- Updated dependencies [3b9a997]
- Updated dependencies [1efa378]
- Updated dependencies [237329e]
- Updated dependencies [af8a173]
  - @opengeni/sdk@6.4.0

## 6.3.1

### Patch Changes

- Updated dependencies [d5db2de]
- Updated dependencies [d91058a]
- Updated dependencies [32bc3e9]
- Updated dependencies [d872b12]
- Updated dependencies [d010825]
- Updated dependencies [c35704f]
- Updated dependencies [c0b945b]
- Updated dependencies [d0295f8]
- Updated dependencies [f4ad926]
- Updated dependencies [a550481]
- Updated dependencies [1afdda0]
  - @opengeni/sdk@6.3.0

## 6.2.1

### Patch Changes

- Updated dependencies [cbfd911]
- Updated dependencies [7c94b6e]
  - @opengeni/sdk@6.2.0

## 6.1.1

### Patch Changes

- Updated dependencies [0422c7b]
- Updated dependencies [6573dc7]
- Updated dependencies [9cf4bc0]
  - @opengeni/sdk@6.1.0

## 6.0.2

### Minor Changes

- f2e1953: Turning on computer use in the desktop app no longer spins forever. When it is on but still not usable after a minute, the switch stops saying "Turning on…" and says why in one line: the server isn't accepting the computer's sign-in, the server can't see it yet, the agent isn't starting, another copy of the agent is in the way, or moving the agent into the app is taking too long, with the agent's own words below when it gave some, and **Try again**. Try again restarts an agent that is already running (its service, or the app's helper), so it signs in and connects right away instead of after its backoff. An agent that has stopped retrying because the server needs it connected again is a problem at once, and turning it on reconnects it. The app's own agent is no longer shown as on, and the menu bar no longer calls the computer available, while the server refuses its sign-in; a connection the agent stopped retrying is enrolled afresh on turning on, even while the server still lists it. `parseConnections` reads each connection's `authentication` state from `opengeni-agent connections`; `ThisComputerStatus` gains `waitingOn` and `waitingDetail`, and `ThisComputerErrorCode` gains `reconnect_required`; `useThisComputer` gains `stalled` and a `turnOnLimitMs` option; `@opengeni/react/this-computer` exports `computerUseStalledText`; `ComputerUseProblem` gains `stalled`.
- e669e43: Turning on computer use in a workspace that uses a connection made in another workspace now reconnects it when the server stopped accepting its sign-in, as it already did for a connection made in the same workspace. While that workspace still lists the computer, it is connected again there, since the server keeps one live connection of a personal computer, and every workspace that used it keeps using it. A computer removed where it was made is never put back there, and one the person can no longer set up there is set up in this workspace instead. The menu bar now says the computer needs reconnecting, with **Reconnect This Computer…**, instead of "connecting…" forever. `ThisComputer.summary()` gains `needsReconnect`.

### Patch Changes

- d7fb082: When credential renewal fails with a server error, the machine agent's log now includes the deployment's correlation id, so the failure can be matched to the server's log entry. Only a plain id is logged, never the response body.
- 1ea8bd6: An agent can commit where nobody configured a Git identity. Commands in a managed sandbox run as a uid with no account entry, and a container connected as a machine usually has no `user.email` and a hostname Git cannot turn into an address, so `git commit` failed with "Author identity unknown" and agents stopped to ask the person for a name and email. The sandbox and desktop images now set `Opengeni Agent <agent@opengeni.invalid>` at Git's system level. On a Connected Machine where Git cannot guess an address and the agent's environment has no `EMAIL`, its commands receive `EMAIL=agent@opengeni.invalid`; a laptop whose hostname gives Git an address keeps it. Both are Git's lowest-precedence sources, so an identity the deployment, the person or the repository configured still wins.
- Updated dependencies [44ba53b]
- Updated dependencies [f385091]
- Updated dependencies [7a5395e]
- Updated dependencies [aa6b340]
- Updated dependencies [f2e1953]
- Updated dependencies [12b773f]
- Updated dependencies [1271da5]
- Updated dependencies [f6c6c0f]
- Updated dependencies [dfc7190]
- Updated dependencies [09972b5]
- Updated dependencies [cebc433]
- Updated dependencies [0ba40f0]
- Updated dependencies [449bcae]
- Updated dependencies [37538aa]
- Updated dependencies [c6ba725]
- Updated dependencies [5a3ed41]
- Updated dependencies [a02dca4]
- Updated dependencies [60c6c56]
- Updated dependencies [6c5a6b5]
- Updated dependencies [accee33]
- Updated dependencies [399757b]
- Updated dependencies [ce001ee]
- Updated dependencies [3c0113c]
- Updated dependencies [71bcf11]
- Updated dependencies [a744c56]
- Updated dependencies [a895f0b]
- Updated dependencies [ad1dc82]
- Updated dependencies [670913f]
- Updated dependencies [3aaf6ed]
- Updated dependencies [77f483f]
- Updated dependencies [a1e75dc]
  - @opengeni/sdk@6.0.0

## 5.5.1

### Patch Changes

- 1908715: Dictation listens for a vocabulary, and dictation from anywhere keeps each dictation's speech to play and transcribe again.

  - A dictation recording's `transcription` takes `keyterms` as well as `language`. The worker passes them to the voice input model when it takes keyterms: ElevenLabs Scribe and Azure Speech as keyterms, OpenAI and Azure OpenAI as the prompt (their text models now report `keyterms: true`, so meetings on them listen for keyterms too).
  - `useVoiceInput` takes `keyterms` and `onAudio`, which hands over each dictation's microphone audio with its text, and returns `transcribe(blob)` to transcribe audio kept earlier as a new dictation.
  - `@opengeni/sdk/recordings`: `uploadRecordingAudio()` uploads finished audio as a one-track recording.
  - `@opengeni/desktop/dictation`: settings gain `vocabulary`, `retryShortcut` (transcribes the last dictation again and types it) and `cancelShortcut`; the status reports `actionShortcutErrors`. The history keeps each dictation's speech on the computer (private to the person, deleted with the history), and `historyAudio(id)` and `transcribeAgain(id)` play and re-transcribe it. While dictation is on, the app opens at login.
  - `DesktopDictationSettings` offers the vocabulary, the retry and cancel shortcuts, and Play and Transcribe again on each recent dictation.

- a18a2e2: The machine agent no longer migrates state from early releases. It stops reading the single-connection `credentials.json` file and the `nats_credentials` key, no longer recognises connections that were converted from that file (`legacy_origin`), and its renewal, update and `connections`/`disconnect` commands work only from the per-connection files. It also stops rewriting systemd units generated before coordinated browser shutdown and the `supervisor` subgroup, stops deleting old `systemctl set-property` drop-ins, and stops removing the Windows Service that early releases registered. A machine still on one of those shapes reconnects with `opengeni-agent connect` or reinstalls its service with `opengeni-agent service install --restart`. The API no longer treats a `legacy_origin` renewal failure as permanent.
- Updated dependencies [fa7516a]
- Updated dependencies [f23588a]
- Updated dependencies [e555018]
- Updated dependencies [22b129b]
- Updated dependencies [9180cf8]
- Updated dependencies [1908715]
- Updated dependencies [cc59c02]
- Updated dependencies [4a86d4d]
- Updated dependencies [8382bdb]
- Updated dependencies [b56bf3f]
- Updated dependencies [031e173]
  - @opengeni/sdk@5.5.0

## 5.4.2

### Patch Changes

- 4641312: Turning on Computer use in a second workspace no longer fails with "this machine was first connected as a personal machine from another workspace". When the computer's existing connection was made without screen control, the app now turns screen control on for that connection (where it was made) and lets agents in the new workspace use it, instead of setting the computer up anew, which the server refuses for a person's own computer. On the server, a personal computer that was removed can now be connected again from any workspace its owner uses; before, it could only come back in the workspace it was first connected from.
- Updated dependencies [d649005]
- Updated dependencies [5aa883b]
- Updated dependencies [4488c59]
- Updated dependencies [3ee89da]
- Updated dependencies [f6298be]
- Updated dependencies [415c32b]
- Updated dependencies [53e1fe5]
- Updated dependencies [d30a243]
- Updated dependencies [de7087a]
- Updated dependencies [a2ae2ce]
- Updated dependencies [96502c5]
- Updated dependencies [1320698]
- Updated dependencies [936d9e0]
- Updated dependencies [4651b0d]
  - @opengeni/sdk@5.4.0

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
- Updated dependencies [21e7ecf]
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
- Updated dependencies [1534f12]
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
