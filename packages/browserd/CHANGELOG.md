# @opengeni/browserd

## 0.2.18

### Patch Changes

- 55323bb: Connected Chrome now refuses pages it cannot control (such as `chrome://` pages, other extensions and the Chrome Web Store) with a typed error that says so, instead of failing later with a generic CDP error, and a refused navigation no longer leaves a stray tab behind.
- b0f5351: Resuming a browser whose earlier resume timed out no longer gets stuck. Before, the resume first tried to end that interrupted attempt, and when the machine still held the attempt's working copy it refused in order to protect it, so the browser could neither be continued nor resumed.

  Now, when the attempt's browser launch completed (still running, or launched and then the machine restarted), the resume asks the machine to re-adopt that exact attempt from its own profile directory, on the same machine instance and under the same controller generation, and marks the browser active again under the same record and history. Nothing is restored over the working copy and nothing is discarded.

  When the launch never recorded completion (for example the machine went down mid-launch), the attempt can't be adopted. If a complete process scan proves no browser is running its profile (Linux), the machine moves the attempt's whole session directory aside intact, under `set-aside/<browser>/<generation>` in its browser state directory, and the browser resumes from its saved checkpoint under the same record. A launch that completed, or whose profile may still be in use (including any platform without that proof), keeps refusing and stays preserved. Machines on agents without this option keep their original refusal.

  Set-aside directories are kept until an operator removes them; nothing deletes or restores them automatically, because they can hold a private signed-in profile.

- aa5b7d8: Only a person's explicit end discards a browser whose controller lost it. Previously any end that removed state did, including the cleanup a failed or expired resume runs, so resuming such a browser could silently throw away its preserved working copy and restart from an older checkpoint. Now that cleanup keeps refusing and preserving it, as before. The end action first asks for a normal end and, only when the machine reports the browser's runtime preserved, asks again with an explicit discard. Machines on agents without the discard option keep their original refusal.
- 5087e5d: Browsers whose runtime or machine is gone can be ended. Previously such a browser could never be closed, so people kept seeing dead browsers:

  - After the agent restarted, ending a managed browser it had launched was refused with "Current browser is unavailable; its browser record and recovery state are preserved". An explicit end of the exact bound controller generation now retires it on the machine: any browser still running that session's private profile is stopped by verified identity (a reused PID is never signalled), the working runtime is retired and the session's local state is removed. Recovery state of any other generation stays preserved.
  - Ending a browser on a removed (revoked) Connected Machine, or a browser in a person's own Chrome whose device is disconnected or whose machine was removed, failed (for example "sandbox not available" or "Attached browser is disconnected"). It now completes in the control plane under the bound controller generation, so that controller stays fenced and the browser's private checkpoint goes to normal retention. Tabs a Chrome browser opened stay with the person as ordinary tabs. A managed browser on a machine that is only offline still waits for the machine, which holds its process and profile.

  `interactionControllerGone` (db) decides this through the viewer's owner-aware machine listing, so a machine hidden from a person is never judged gone.

- Updated dependencies [501bb83]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
- Updated dependencies [d367818]
  - @opengeni/contracts@3.0.0
  - @opengeni/interaction@3.0.0

## 0.2.17

### Patch Changes

- Updated dependencies [2ea5f7b]
  - @opengeni/contracts@2.0.1
  - @opengeni/interaction@2.0.1

## 0.2.16

### Patch Changes

- ab03f44: A requested agent update on a busy machine now waits for the machine to become idle instead of failing with `update_busy_work`. The agent accepts the update, reports it as waiting for idle (with the reason), keeps admitting new work, and re-attempts its short idle proof every few seconds until it can apply. Open browser and computer sessions no longer count as busy when a restart would lose nothing: a quiescent managed browser whose owned process survives graceful shutdown and is reattached on its next request, a session whose browser already ended, and a computer session on the machine's own physical seat. Admitted commands, attached browser sessions, browsers without a durable working runtime and isolated virtual desktops still keep the update waiting.
- 2952b97: Make clicks and hovers in attached Chrome fast again. Agent tabs open in the background so the user's foreground tab is left alone, and Chrome held every mouse event sent to such a hidden tab for about five seconds before acknowledging it, so each click cost over five seconds regardless of how many agents ran. Attached sessions now use the same target-local focus emulation as managed browsers, which keeps a background tab rendering and taking input without activating it; Chrome clears it when the debugger detaches. The extension admits exactly `Emulation.setFocusEmulationEnabled` and no other Emulation method. Browserd keeps working with older extensions that reject it, at the old speed, until the extension updates.
- 2634253: Keep attached Chrome sessions alive across agent restarts, agent updates and native-host reconnects. Every native reconnect used to give the profile a new connection generation, which ended all of its live browser sessions with `controller_transition_expired`, so an agent update or a brief native-host exit lost every agent's attached browser. The extension now also reports a state generation that lasts for its worker's lifetime, the span in which Chrome keeps its tab ids and debugger attachments, and the agent binds the profile's placement to it while still fencing each native port with the per-port generation. Because a quiescent attached session now survives a restart, it no longer holds back an agent update; the agent still waits while an older extension without a state generation backs a live attached controller.
- 055015d: Browser action receipts now say which element each locator resolved to: its role, name, reference, and the nearest dialog, landmark, menu or toolbar around it. A "Close" that hit the page header instead of a dialog is now visible in the receipt. Controllers add the field only when the caller asks for it, and never store it in their operation journal, so older and newer API and controller versions keep working together.
- 2a25879: When a browser action becomes `outcome_unknown` because a later step failed, the receipt now keeps that step's reason (for example "browser element is covered or not pointer-actionable"), not only its error code, so agents can correct the target without replaying.
- 57b5a95: Browser fill now works on native date, time, month, week and datetime-local inputs. Fill sets the input's value in its own format (for example HH:MM for time) and notifies the page as user input, whether the locator points at the input or at one of its hour, minute or date parts. Previously it cleared the focused part and then reported an unknown outcome. A value that does not match the input's format is refused before anything changes, with the expected format in the error. Snapshots offer fill on the input itself, not on its part spin buttons.
- 2263020: On Linux machines with a systemd user manager, each managed browser now runs in its own transient scope (`opengeni-browser-<id>.scope`) under `opengeni-browsers.slice` instead of inside the agent's service. Stopping, restarting or updating the agent service therefore no longer kills any of a browser's processes (previously its renderer, GPU and utility processes died with the service, crashing every tab), and each browser's memory and CPU are visible per browser. The slice sets no resource limits. The launch keeps Chrome's process ID unchanged, and Chromium's own move of its main process into an app scope is undone after launch so the whole browser stays one unit. Machines without a reachable user manager launch browsers exactly as before.
- 4b2d2c5: Browser press accepts the function keys F1-F24 and the navigation keys Home, End, PageUp, PageDown, Insert and ContextMenu, plus the common short spellings (Esc, Return, Del, PgUp, PgDn, Up, Down, Left, Right). Before, any of these was refused as an unsupported key even though the tool schema accepts any key string, so an agent could not, for example, press F2 to edit a grid cell. Genuinely unknown keys are still refused before focus moves or any input is sent. The browser action tool description now lists the accepted key names.
- 1ee99c1: Report a crashed browser tab as a definite, non-retryable `tab_crashed` diagnosis with open-a-new-tab guidance through browserd and the API. Previously the API turned it into a generic "temporarily unavailable, retry" outage, so agents kept retrying a dead tab.
- 1756cfe: Preserve a typed tab_not_responding diagnosis and recovery guidance when page-scoped CDP commands time out. Reads and pre-input failures are definite; actions whose input was already sent retain uncertain effects and must not be replayed automatically. Healthy tabs remain usable.
- 4f82ee7: A browser tab whose page process crashed no longer hangs every command until it times out with a retryable "upstream unavailable" error. The browser service now notices the crash, both when it happens and when it later attaches to an already-crashed tab. It fails page commands on that tab at once with a clear, non-retryable error that says to open a new tab. The rest of the browser keeps working.
- c0bba27: A browser refusal to focus the locator of press, fill or type (for example the page document node) is now a definite invalid_action with nothing sent, instead of an unknown outcome.
- 262e6b5: A managed browser whose restored launch failed before it finished can be resumed again. Previously, if Chrome started from a restored private profile but the launch then threw, cleanup removed the profile but left the launch record "in progress". Every later cleanup or resume of that browser was then refused as "Current browser is unavailable", and the stuck resume eventually marked the browser lost.

  Now the browser service records such a launch as failed, with a short error code, and logs the original error. Cleanup of that exact controller generation succeeds, so the next resume restores again from the saved private checkpoint. Launch records left "in progress" by earlier versions are treated the same way when no process was recorded and the restored profile is gone. A launch that might still be running stays protected as before.

  A browser that was lost because its resume timed out (`controller_transition_expired` after a resume) can now be resumed through the normal resume request. The API first ends the old controller generation, then returns the browser to suspended and restores it from the same checkpoint under a new generation. Browsers lost during create, suspend or end are unchanged.

- a619cad: A browser click or hover on a control that only accepts the pointer while its row or card is hovered (a common pattern for row actions such as "add" or "more" buttons) now moves the pointer onto it first, as a person would, and then clicks. Before, the hit test fell through the hidden control to its row and the action was refused. A control that stays unreachable after the pointer arrives is still refused, reported as an unknown outcome because the pointer moved.
- c3e192d: A click or hover on a target that is already in view, but covered or without a box, is now a definite refusal instead of an unknown outcome. Refusals after an actual scroll stay unknown, because scrolling can run page handlers.
- 900f37c: Restoring a checkpointed tab set now keeps the live tab that startup selected for the primary page instead of re-selecting a reopened tab with the same URL whose renderer crashed, so resume no longer fails with "This browser tab crashed".
- d91c6d5: A browser click on a target hidden under a sticky table column, a sticky header or a small fixed toolbar now scrolls the target out from under it, trying other scroll alignments, and then clicks. Before, the click was refused as covered. A layer over the whole viewport, such as a modal backdrop, is still a definite refusal, and nothing is scrolled.
- 07fb2a3: A browser scroll aimed at an element now scrolls the nearest box around it that can actually move in that direction, as a mouse wheel over the element would, instead of calling scroll on the element itself, which did nothing for tables, rows and plain wrappers inside a scrolling panel. When nothing can move (already at the edge, or no scrollable box), both located and page scrolls now fail with a definite error instead of reporting success.
- 51e3048: Browser actions no longer report a menu, listbox or dialog that the action just closed as still open. Before the post-action snapshot, the driver briefly waits for finite running animations to finish, so exit animations complete and the element leaves the page first. Infinite animations such as spinners are ignored, and the wait is capped at 750 ms.
- 8a5446d: Starting a managed browser no longer fails when a tab reopened from a restored profile has a crashed renderer. Startup selects the first live tab, or opens a new one when none is live, and keeps the crashed tab in the tab list for the user to close.
- ce3587b: Startup reaping of stale browser sessions now reads the Linux process inventory once per pass and fully identity-checks only processes that name the exact profile, so a machine with many retained session directories no longer exceeds the browser sidecar readiness timeout.
- 13754f1: Rename a shadowing test helper parameter so the repository lint passes with warnings denied.
- ca2204a: Validate a press key before focusing its locator, so an unsupported key is a definite invalid_action with no input sent instead of outcome_unknown.
- 4fa68d5: Agent updates and controller restarts no longer close managed browsers. Graceful browserd shutdown now detaches from a browser with a durable working runtime instead of closing it, so its tabs and unsaved page state (open editors, half-filled forms) stay live, and the next controller adopts the same process on its next request. Previously, shutdown closed Chrome and recovery relaunched it in the same profile: cookies and storage survived, but live page state was lost. Live reattachment now also works for headed browsers, for a launcher from an earlier agent release, and for a browser whose launcher was killed with a stopped service. A stale launcher record whose PID now names an unrelated process is still refused.
- Updated dependencies [fc57bd2]
- Updated dependencies [04ebc42]
- Updated dependencies [ab03f44]
- Updated dependencies [e03f1ff]
- Updated dependencies [c2f4153]
- Updated dependencies [de2d721]
- Updated dependencies [055015d]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [6861501]
- Updated dependencies [bfed4f1]
- Updated dependencies [4532435]
- Updated dependencies [f96605f]
- Updated dependencies [496ce55]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [ce7b403]
- Updated dependencies [445baf4]
- Updated dependencies [5b4a738]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [f7d53b2]
- Updated dependencies [c13d080]
- Updated dependencies [061ae01]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [6313dd8]
- Updated dependencies [945490f]
- Updated dependencies [8e878ac]
- Updated dependencies [9701372]
- Updated dependencies [bc40348]
- Updated dependencies [5eb1c32]
- Updated dependencies [da01634]
- Updated dependencies [ab3306a]
- Updated dependencies [4cb80a9]
- Updated dependencies [eb68b58]
- Updated dependencies [38b1ba1]
- Updated dependencies [6960770]
- Updated dependencies [3426850]
- Updated dependencies [412671a]
- Updated dependencies [63bf721]
- Updated dependencies [3a4a435]
- Updated dependencies [14343e4]
- Updated dependencies [2b8ee21]
- Updated dependencies [71c42bf]
- Updated dependencies [a390b9e]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [322f26c]
- Updated dependencies [945c247]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [5cb6d71]
- Updated dependencies [732a788]
- Updated dependencies [8cf9e0a]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [7ce535f]
- Updated dependencies [35fb6fd]
- Updated dependencies [35fb6fd]
- Updated dependencies [7bf1a02]
- Updated dependencies [a13bf1a]
- Updated dependencies [a91718c]
  - @opengeni/contracts@2.0.0
  - @opengeni/interaction@2.0.0

## 0.2.15

### Patch Changes

- Updated dependencies [6384dbd]
  - @opengeni/contracts@1.4.4
  - @opengeni/interaction@1.4.4

## 0.2.14

### Patch Changes

- @opengeni/contracts@1.4.3
- @opengeni/interaction@1.4.3

## 0.2.13

### Patch Changes

- @opengeni/contracts@1.4.2
- @opengeni/interaction@1.4.2

## 0.2.12

### Patch Changes

- Updated dependencies [9145bad]
- Updated dependencies [f290348]
  - @opengeni/contracts@1.4.1
  - @opengeni/interaction@1.4.1

## 0.2.11

### Patch Changes

- Updated dependencies [bd9521c]
- Updated dependencies [08ce841]
- Updated dependencies [673bb53]
  - @opengeni/contracts@1.4.0
  - @opengeni/interaction@1.4.0

## 0.2.10

### Patch Changes

- Updated dependencies [178b5ae]
- Updated dependencies [414d416]
  - @opengeni/contracts@1.3.0
  - @opengeni/interaction@1.3.0

## 0.2.9

### Patch Changes

- Updated dependencies [21c8904]
- Updated dependencies [d870f32]
  - @opengeni/contracts@1.2.0
  - @opengeni/interaction@1.2.0

## 0.2.8

### Patch Changes

- Updated dependencies [5fd6c55]
- Updated dependencies [c600e3a]
- Updated dependencies [411b3b5]
- Updated dependencies [208dec1]
  - @opengeni/contracts@1.1.0
  - @opengeni/interaction@1.1.0

## 0.2.7

### Patch Changes

- Updated dependencies [4476ca7]
- Updated dependencies [e16aa17]
  - @opengeni/contracts@1.0.1
  - @opengeni/interaction@1.0.1

## 0.2.6

### Patch Changes

- Updated dependencies [aa41b15]
- Updated dependencies [af57cf9]
- Updated dependencies [8ce490f]
- Updated dependencies [692a1f5]
- Updated dependencies [e0d4bd4]
- Updated dependencies [c7c09fd]
- Updated dependencies [2f09c54]
- Updated dependencies [303ed6c]
- Updated dependencies [9ca494c]
- Updated dependencies [3395acc]
- Updated dependencies [18216d2]
- Updated dependencies [746464c]
- Updated dependencies [6cdc0aa]
- Updated dependencies [0fba21e]
- Updated dependencies [97d4f07]
- Updated dependencies [14e95e9]
- Updated dependencies [8323e90]
  - @opengeni/contracts@5.8.0
  - @opengeni/interaction@0.4.47

## 0.2.5

### Patch Changes

- 45e1b4f: Separate desktop backend operations from OpenGeni's session controller and viewer. The native helper retains its existing transport and behavior; alternative desktop drivers can reuse the same receipts, media delivery and access boundary.
- Updated dependencies [12ef019]
- Updated dependencies [45e1b4f]
- Updated dependencies [da4ba6f]
- Updated dependencies [697263e]
- Updated dependencies [56584f9]
- Updated dependencies [31e3771]
- Updated dependencies [76ff363]
- Updated dependencies [d2fe11d]
- Updated dependencies [cbb3e36]
- Updated dependencies [479ec20]
- Updated dependencies [70af8bb]
- Updated dependencies [3a921bf]
  - @opengeni/contracts@5.7.0
  - @opengeni/interaction@0.4.46

## 0.2.4

### Patch Changes

- Updated dependencies [e5b0123]
- Updated dependencies [4762e1a]
  - @opengeni/contracts@5.6.0
  - @opengeni/interaction@0.4.45

## 0.2.3

### Patch Changes

- d7e5c70: Defer native agent upgrades while browser or computer controllers remain open,
  including queued creation and shutdown. Keep idle proof private to the host and
  preserve ordinary work when controller state cannot be verified.
- Updated dependencies [a6ff780]
- Updated dependencies [0bbe2e7]
- Updated dependencies [55f1cdd]
- Updated dependencies [45d1301]
- Updated dependencies [45d1301]
- Updated dependencies [fd5fb34]
- Updated dependencies [b45621d]
- Updated dependencies [45d1301]
- Updated dependencies [f874217]
- Updated dependencies [45d1301]
- Updated dependencies [0bbe2e7]
- Updated dependencies [3545ca3]
- Updated dependencies [45d1301]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [45d1301]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
  - @opengeni/contracts@5.5.0
  - @opengeni/interaction@0.4.44

## 0.2.2

### Patch Changes

- Updated dependencies [01f50bf]
- Updated dependencies [3f9c757]
- Updated dependencies [378327b]
- Updated dependencies [872391f]
- Updated dependencies [aad6598]
- Updated dependencies [6146167]
- Updated dependencies [3f9c757]
- Updated dependencies [9732749]
- Updated dependencies [6f28afd]
- Updated dependencies [a6854a7]
- Updated dependencies [b591ea1]
- Updated dependencies [a82657f]
- Updated dependencies [cabfc5e]
- Updated dependencies [8669490]
- Updated dependencies [7a08660]
- Updated dependencies [57f030c]
- Updated dependencies [3f9c757]
- Updated dependencies [3f9c757]
- Updated dependencies [f986809]
- Updated dependencies [1ea4c69]
- Updated dependencies [11151c6]
- Updated dependencies [30414a0]
- Updated dependencies [514f8ea]
- Updated dependencies [b28d5fa]
- Updated dependencies [e193b13]
- Updated dependencies [14990d0]
- Updated dependencies [bcd9988]
- Updated dependencies [d1f4724]
  - @opengeni/contracts@5.4.0
  - @opengeni/interaction@0.4.43

## 0.2.1

### Patch Changes

- Updated dependencies [509513d]
  - @opengeni/interaction@0.4.42

## 0.2.0

### Minor Changes

- 585f2c1: Add an operator-disabled ephemeral Chromium BrowserSession mode for disposable sandbox verification. Explicit requests use isolated browser contexts within a trusted actor and placement partition, preserve existing private-profile defaults, and become terminal after shared process loss instead of silently recreating or replaying work.
- 02af186: Add an optional verified Chrome headless-shell bundle for new managed headless profiles, preserving headed defaults and pinning profile recovery to the selected launcher.

### Patch Changes

- 2b0c23c: Disable Chromium's local AI model downloads in managed browsers, omit disposable model weights from profile checkpoints, and tolerate Linux processes disappearing during shutdown checks.
- 78f1d59: Offer native dropdown choices in BrowserViewer when Chromium page frames omit the popup. Keep selection bound to the observed control and preserve normal input/change events, private-field redaction, and disabled options.
- f3e3b2d: Continue exact-profile browser cleanup when an unrelated Linux process disappears during procfs discovery. Preserve unexpected read failures and the executable/profile ownership checks before signalling a process.
- dc77d7f: Classify CDP transport failures from read-only browser target inventory and observation as retryable timeout or unavailable responses. Keep target mutations and journaled action outcome handling unchanged.
- 8e2ba2b: Add a construction-only experimental Chromium context pool for bounded disposable verification, with context-scoped target authority and terminal failure handling. Dedicated managed browsers remain unchanged; no production path enables the pool.
- ec707de: Negotiate bounded viewer typing batches from the active browser controller. Preserve
  individual text events and input order while reducing request overhead; recheck the
  original document fence before each action and discard uncertain queued input
  without replay. Older controllers retain sequential input.
- b870388: Recover a lost managed Lightpanda process through the existing browser lifecycle. Safe reads resume after recovery; stale actions remain fenced and ambiguous mutations are never replayed.
- c5189e7: Replace existing Lightpanda input values during ordinary and protected fills,
  including empty values, while preserving native input events and rejecting
  unsupported or non-editable targets.
- a63a029: Reject Lightpanda placeholder images as screenshots and correct screenshot
  capabilities for existing semantic-only sessions. Keep DOM observation available.
- 774369f: Drain managed Linux Chrome stderr into a bounded private diagnostic file so noisy browsers cannot block their CDP control channel.
- 8693783: Keep bounded browser streams at a stable clip scale so raster rounding cannot make unchanged mobile pages oscillate in size.
- Updated dependencies [1842911]
- Updated dependencies [ab4d25f]
- Updated dependencies [585f2c1]
- Updated dependencies [ec707de]
- Updated dependencies [3aab8f9]
  - @opengeni/contracts@5.3.0
  - @opengeni/interaction@0.4.41

## 0.1.48

### Patch Changes

- Updated dependencies [084616e]
- Updated dependencies [1a427e0]
- Updated dependencies [6eb431b]
- Updated dependencies [48a8774]
- Updated dependencies [e422b62]
- Updated dependencies [bd365b7]
  - @opengeni/contracts@5.2.0
  - @opengeni/interaction@0.4.40

## 0.1.47

### Patch Changes

- Updated dependencies [23f4717]
  - @opengeni/contracts@5.1.1
  - @opengeni/interaction@0.4.39

## 0.1.46

### Patch Changes

- Updated dependencies [d92af11]
- Updated dependencies [f60ca2b]
- Updated dependencies [86c710a]
- Updated dependencies [2f8bc58]
  - @opengeni/contracts@5.1.0
  - @opengeni/interaction@0.4.38

## 0.1.45

### Patch Changes

- Updated dependencies [6d0a4de]
- Updated dependencies [c64a94f]
- Updated dependencies [1c924ed]
- Updated dependencies [c31a951]
- Updated dependencies [f90d628]
- Updated dependencies [aa09567]
- Updated dependencies [d1ab270]
- Updated dependencies [c8bb974]
- Updated dependencies [3fa175e]
- Updated dependencies [332a02d]
- Updated dependencies [132b945]
- Updated dependencies [779b16b]
- Updated dependencies [1cb688d]
- Updated dependencies [9d9b94b]
- Updated dependencies [621201d]
- Updated dependencies [f90d628]
- Updated dependencies [1bfb6a4]
- Updated dependencies [7e2436a]
- Updated dependencies [9d9b94b]
- Updated dependencies [c66ba31]
- Updated dependencies [f7c9169]
- Updated dependencies [0ea365c]
  - @opengeni/contracts@5.0.0
  - @opengeni/interaction@0.4.37

## 0.1.44

### Patch Changes

- Updated dependencies [7746251]
- Updated dependencies [85cafd0]
  - @opengeni/contracts@4.1.0
  - @opengeni/interaction@0.4.36

## 0.1.43

### Patch Changes

- 88f92b9: Reacquire the live capture source when a viewer renews while its previous subscription is retiring, preventing renewal from attaching to a stopped source.
- Updated dependencies [50ac837]
- Updated dependencies [ad9dc2f]
- Updated dependencies [750060c]
- Updated dependencies [da4a85f]
- Updated dependencies [123cf57]
- Updated dependencies [efeaa9c]
  - @opengeni/contracts@4.0.0
  - @opengeni/interaction@0.4.35

## 0.1.42

### Patch Changes

- Updated dependencies [4e2b59d]
- Updated dependencies [488a69b]
- Updated dependencies [935af4e]
- Updated dependencies [d08dbb6]
  - @opengeni/contracts@3.1.0
  - @opengeni/interaction@0.4.34

## 0.1.41

### Patch Changes

- Updated dependencies [e1a50ba]
  - @opengeni/contracts@3.0.2
  - @opengeni/interaction@0.4.33

## 0.1.40

### Patch Changes

- Updated dependencies [6a60a58]
  - @opengeni/contracts@3.0.1
  - @opengeni/interaction@0.4.32

## 0.1.39

### Patch Changes

- Updated dependencies [cffd21b]
- Updated dependencies [f8be7df]
- Updated dependencies [cffd21b]
  - @opengeni/contracts@3.0.0
  - @opengeni/interaction@0.4.31

## 0.1.38

### Patch Changes

- Updated dependencies [1b0f4f2]
  - @opengeni/contracts@2.15.2
  - @opengeni/interaction@0.4.30

## 0.1.37

### Patch Changes

- Updated dependencies [068be26]
- Updated dependencies [2fa33e4]
  - @opengeni/contracts@2.15.1
  - @opengeni/interaction@0.4.29

## 0.1.36

### Patch Changes

- Updated dependencies [231b103]
- Updated dependencies [392c575]
- Updated dependencies [9827c25]
- Updated dependencies [5904fd1]
- Updated dependencies [14dd6fe]
  - @opengeni/contracts@2.15.0
  - @opengeni/interaction@0.4.28

## 0.1.35

### Patch Changes

- Updated dependencies [22a6704]
- Updated dependencies [4536385]
- Updated dependencies [7dac7e3]
- Updated dependencies [fa2b99a]
- Updated dependencies [fa12951]
- Updated dependencies [c1dc59b]
- Updated dependencies [1fc0889]
- Updated dependencies [d06450c]
- Updated dependencies [d9dbd5d]
- Updated dependencies [c69ad5f]
- Updated dependencies [1c4b707]
- Updated dependencies [c90f3fc]
- Updated dependencies [414946c]
- Updated dependencies [0c39126]
- Updated dependencies [0c39126]
- Updated dependencies [575af5b]
- Updated dependencies [6de9fe3]
- Updated dependencies [cda46e8]
- Updated dependencies [b1d3673]
- Updated dependencies [2fb17fd]
- Updated dependencies [3a29372]
- Updated dependencies [107aa14]
- Updated dependencies [d8a70ec]
- Updated dependencies [0a81cc8]
  - @opengeni/contracts@2.14.0
  - @opengeni/interaction@0.4.27

## 0.1.34

### Patch Changes

- Updated dependencies [6b65383]
  - @opengeni/contracts@2.13.0
  - @opengeni/interaction@0.4.26

## 0.1.33

### Patch Changes

- Updated dependencies [d63ee0f]
- Updated dependencies [b420912]
  - @opengeni/contracts@2.12.0
  - @opengeni/interaction@0.4.25

## 0.1.32

### Patch Changes

- Updated dependencies [38de50d]
- Updated dependencies [8b42f58]
- Updated dependencies [0214875]
- Updated dependencies [e2a668b]
- Updated dependencies [9c45eae]
  - @opengeni/contracts@2.11.1
  - @opengeni/interaction@0.4.24

## 0.1.31

### Patch Changes

- Updated dependencies [8f81b57]
  - @opengeni/contracts@2.11.0
  - @opengeni/interaction@0.4.23

## 0.1.30

### Patch Changes

- Updated dependencies [2d0fad4]
- Updated dependencies [9fe5c5b]
- Updated dependencies [c356468]
- Updated dependencies [9af1666]
  - @opengeni/contracts@2.10.0
  - @opengeni/interaction@0.4.22

## 0.1.29

### Patch Changes

- Updated dependencies [5b9acd1]
  - @opengeni/contracts@2.9.2
  - @opengeni/interaction@0.4.21

## 0.1.28

### Patch Changes

- Updated dependencies [b471a90]
- Updated dependencies [96624a7]
- Updated dependencies [4bacdd3]
  - @opengeni/contracts@2.9.1
  - @opengeni/interaction@0.4.20

## 0.1.27

### Patch Changes

- Updated dependencies [699477a]
- Updated dependencies [ddce5cc]
- Updated dependencies [132c8d3]
- Updated dependencies [88b6b48]
  - @opengeni/contracts@2.9.0
  - @opengeni/interaction@0.4.19

## 0.1.26

### Patch Changes

- Updated dependencies [595939e]
- Updated dependencies [80d7594]
  - @opengeni/contracts@2.8.0
  - @opengeni/interaction@0.4.18

## 0.1.25

### Patch Changes

- Updated dependencies [c116379]
  - @opengeni/contracts@2.7.1
  - @opengeni/interaction@0.4.17

## 0.1.24

### Patch Changes

- Updated dependencies [7238fa4]
  - @opengeni/contracts@2.7.0
  - @opengeni/interaction@0.4.16

## 0.1.23

### Patch Changes

- Updated dependencies [a7912ea]
- Updated dependencies [9ef491b]
- Updated dependencies [986f5fe]
- Updated dependencies [6e12f3a]
  - @opengeni/contracts@2.6.0
  - @opengeni/interaction@0.4.15

## 0.1.22

### Patch Changes

- Updated dependencies [76d6396]
- Updated dependencies [b5071cf]
  - @opengeni/contracts@2.5.0
  - @opengeni/interaction@0.4.14

## 0.1.21

### Patch Changes

- Updated dependencies [47b88d3]
- Updated dependencies [c5e4684]
- Updated dependencies [977fa0f]
- Updated dependencies [9d251cb]
- Updated dependencies [dc10a36]
  - @opengeni/contracts@2.4.0
  - @opengeni/interaction@0.4.13

## 0.1.20

### Patch Changes

- Updated dependencies [1b21135]
- Updated dependencies [f30555c]
- Updated dependencies [47ccfab]
- Updated dependencies [b74e557]
- Updated dependencies [b2cd0f0]
  - @opengeni/contracts@2.3.0
  - @opengeni/interaction@0.4.12

## 0.1.19

### Patch Changes

- Updated dependencies [4be2055]
- Updated dependencies [de3f376]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [bbd19e0]
- Updated dependencies [e91d89e]
- Updated dependencies [5d664d8]
  - @opengeni/contracts@2.2.0
  - @opengeni/interaction@0.4.11

## 0.1.18

### Patch Changes

- Updated dependencies [ab81e47]
  - @opengeni/contracts@2.1.1
  - @opengeni/interaction@0.4.10

## 0.1.17

### Patch Changes

- Updated dependencies [3e1ad07]
- Updated dependencies [438e476]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
- Updated dependencies [9b4d5d5]
- Updated dependencies [492fb71]
- Updated dependencies [fbc760e]
- Updated dependencies [650d6f9]
- Updated dependencies [650d6f9]
- Updated dependencies [fe54954]
- Updated dependencies [f7497fd]
- Updated dependencies [ff011e6]
- Updated dependencies [ba0be3d]
- Updated dependencies [5b509be]
- Updated dependencies [c7cafb1]
- Updated dependencies [5a651c8]
- Updated dependencies [29a44c2]
- Updated dependencies [48b9f09]
  - @opengeni/contracts@2.1.0
  - @opengeni/interaction@0.4.9

## 0.1.16

### Patch Changes

- 5dc88ef: Terminalize attached Chrome Browser/Computer sessions when the device connection generation changes, stop Reconnect from retrying the stale placement, and physically stop ScreenCaptureKit helpers so replayd cannot accumulate.
- Updated dependencies [1c78ed0]
- Updated dependencies [f4afa19]
- Updated dependencies [8583779]
- Updated dependencies [79ee99b]
- Updated dependencies [2cb04e0]
- Updated dependencies [6d22ab5]
  - @opengeni/contracts@2.0.0
  - @opengeni/interaction@0.4.8

## 0.1.15

### Patch Changes

- Updated dependencies [b05130a]
- Updated dependencies [55e0417]
  - @opengeni/contracts@1.4.0
  - @opengeni/interaction@0.4.7

## 0.1.14

### Patch Changes

- Updated dependencies [4c2d958]
- Updated dependencies [4c2d958]
  - @opengeni/contracts@1.3.0
  - @opengeni/interaction@0.4.6

## 0.1.13

### Patch Changes

- Updated dependencies [ca75ed9]
- Updated dependencies [c297fc0]
- Updated dependencies [91d5caf]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [e9aabaa]
- Updated dependencies [1f860f0]
- Updated dependencies [c297fc0]
- Updated dependencies [22c0c21]
- Updated dependencies [4eb7abd]
- Updated dependencies [89d4ab3]
- Updated dependencies [7454580]
- Updated dependencies [16cbd7b]
- Updated dependencies [30ba620]
- Updated dependencies [d168b8f]
- Updated dependencies [6860c5f]
- Updated dependencies [f72563d]
- Updated dependencies [c297fc0]
- Updated dependencies [6c45ceb]
- Updated dependencies [c297fc0]
  - @opengeni/contracts@1.2.0
  - @opengeni/interaction@0.4.5

## 0.1.12

### Patch Changes

- 4d1ed07: Preserve complete bounded lazy-search tool schemas across durable model history, expose Linux desktop application launch when the image supports it, suppress the managed Chrome sandbox warning, label Computer sessions as Desktops in the UI, and keep AnyDoc available in headed desktop sandboxes.
- 79f57b5: Prime an exact frame fence when the first observation of a capturable computer target has not yet been viewed, allowing safe first pointer actions without continuous capture overhead. Browser fills now return `outcome_unknown` when a custom editor silently discards the dispatched value instead of claiming completion.
- Updated dependencies [90c0c3e]
- Updated dependencies [9c4e0b8]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [eeb7cb6]
- Updated dependencies [c3f0598]
- Updated dependencies [d2f172c]
- Updated dependencies [04b1a1f]
- Updated dependencies [c056063]
  - @opengeni/contracts@1.1.0
  - @opengeni/interaction@0.4.4

## 0.1.11

### Patch Changes

- Updated dependencies [448117d]
  - @opengeni/contracts@1.0.1
  - @opengeni/interaction@0.4.3

## 0.1.10

### Patch Changes

- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/contracts@1.0.0
  - @opengeni/interaction@0.4.2

## 0.1.9

### Patch Changes

- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/contracts@0.50.0
  - @opengeni/interaction@0.4.1

## 0.1.8

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/contracts@0.49.0
  - @opengeni/interaction@0.4.0

## 0.1.7

### Patch Changes

- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
  - @opengeni/contracts@0.48.0
  - @opengeni/interaction@0.3.3

## 0.1.6

### Patch Changes

- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [746bbbe]
- Updated dependencies [9849e25]
- Updated dependencies [1e78f58]
  - @opengeni/contracts@0.47.0
  - @opengeni/interaction@0.3.2

## 0.1.5

### Patch Changes

- Updated dependencies [3d74340]
  - @opengeni/contracts@0.46.0
  - @opengeni/interaction@0.3.1

## 0.1.4

### Patch Changes

- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
- Updated dependencies [d15d3e8]
- Updated dependencies [733c22f]
  - @opengeni/contracts@0.45.0
  - @opengeni/interaction@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [b57d61f]
- Updated dependencies [5c5ea4a]
  - @opengeni/contracts@0.44.1
  - @opengeni/interaction@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/contracts@0.44.0
  - @opengeni/interaction@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [b46f4de]
- Updated dependencies [2f4ce5e]
- Updated dependencies [d55a093]
- Updated dependencies [dcfe6eb]
- Updated dependencies [ad9123b]
- Updated dependencies [31666e2]
- Updated dependencies [bd5514e]
- Updated dependencies [90eea29]
- Updated dependencies [a858835]
- Updated dependencies [5fcad0a]
  - @opengeni/contracts@0.43.0
  - @opengeni/interaction@0.2.0
