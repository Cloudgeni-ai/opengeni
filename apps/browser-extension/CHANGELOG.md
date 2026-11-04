# @opengeni/browser-extension

## 0.2.4

### Patch Changes

- 923c161: Keep known numeric secrets masked when payment widgets add digit grouping, and
  redact complete three-digit security codes without shortening the existing
  clipped-password prefix threshold. Browser protected-field discovery now covers
  accessibility as well as DOM reads, including frames and flattened closed
  shadow roots. Payment fills accept formatting-only grouping, not changed digits.
  Browser tabs that encounter payment fields or known card data withhold screenshots,
  live frames and video while preserving semantic controls and unrelated tabs. Privacy-discovery and masking
  failures withhold output instead of returning unprotected data.
  The Chrome extension admits the read-only privacy snapshot method. Hidden
  metadata and expiry options stay protected in place without becoming session
  secrets; remembered card numbers and security codes cannot age out behind
  unrelated values.
  The extension advertises the additive privacy capability to the native agent;
  older extensions receive the existing update-required refusal and start
  Chrome's update check before protected reads are allowed.

## 0.2.3

### Patch Changes

- 205b05a: Agents can now set camera, microphone, geolocation and notifications permissions in the person's own Chrome, for the exact top-level origin (scheme, host and port) of a tab the session opened and no other session is using; the person's own tabs are refused. The first such action opens a page in the extension where the person allows it once; until then the action fails with a short message saying so. The extension records every change and lists it in its popup with Remove, Chrome shows the settings as set by an extension in its normal site settings, and setting a permission back to prompt clears it. Other permission types, and extensions without this support, fail with a clear message. The browser_act description no longer says permission actions only work in managed browsers.
- 8af985d: Attached Chrome keeps working on sign-in pages whose password manager loads its inline menu into a frame it created blank. The extension found other extensions' frames only by their address, and such a frame's address stays blank while it shows the other extension's page, so Chrome kept refusing the tab and every call failed with "it could not be removed". The extension now also removes such a frame when it is the one place the tab can hold that page. Chrome's debugging targets show other extensions' pages only for the whole browser, and Chrome does not list every frame of a page to the extension (it omits other extensions' pages and some of the page's own, such as a data: page loaded by script into a blank frame). So the frame must be the tab's only frame the extension cannot see into and hold no frames of its own, every frame Chrome lists must have run the extension's script and said so, the page must add no frame while the extension searches and hold no other extension's page found by its address, and Chrome's debugging targets must hold another extension's page. A frame that merely does not answer is never removed, so a page's own frames (including error pages, data: frames, frames still loading or posting, and sites the person took the extension's access from) always stay; when the page holds one of those, the menu frame is not removed either, and the tab can be debugged again once the menu closes. This adds the `webNavigation` permission, which brings no new permission warning. A removal that removes nothing no longer counts towards the tab's removal limit, so it is no longer reported as an extension that keeps adding its frame.

  An observation made just before Chrome ended the tab's debugging (as it does whenever another extension adds a frame) now still holds when the new attachment finds the same document. browserd used to give every new attachment a new target, document and frame generation, so an action right after a fresh observation failed with `target_stale` whenever a password manager's menu appeared in between. A new attachment now keeps the ended one's generations and element references when the tab's main frame still has the same frame and loader ids; a new document, a crash or a closed tab still gets fresh ones, and commands of the ended attachment still never reach the new one.

## 0.2.2

### Patch Changes

- 1a4e2ec: Attached Chrome keeps working in a tab while a password manager shows its inline menu. Chrome ends the extension's debugging of a tab as soon as another extension's frame starts loading in it, and while that frame loads it can refuse every command on a new attachment without running it. The extension now removes those frames and sends a refused command again once (never onto a different attachment). Commands refused together for the same frame share one removal, so they count once against the existing limit on how often the extension removes frames, and only Chrome's actual refusal starts a removal. A removal the page does not answer within a few seconds is given up rather than holding up the tab, and a frame added back right after the removal a refusal reused is removed once more. A frame that keeps coming back fails with the existing error that names the password manager and says what to do.

  browserd now treats Chrome's "Debugger is not attached" answer as the end of that attachment instead of an unclassified error, so the next call attaches again. Observations, tab state, page reads and screenshots whose attachment ends part way are read once more on a new attachment. An action whose attachment ends after input was sent is `outcome_unknown` with a fresh observation of the tab on the new attachment, so the agent can see whether the input landed; an action that ended before any input stays a definite `failed`. Chrome also gives its other-extension-frame refusal for a tab it is about to stop debugging, so with an extension that relays that refusal as is, the first one ends the attachment the same way; only a refusal that persists on a new attachment is a definite failure that says what to do, rather than a retryable error that never cleared. The tab state and page read routes of browserd no longer answer a lost attachment with a 500.

- c3aa91c: Attached Chrome sessions now survive a restart of the extension's background worker. Chrome stops and restarts an extension's worker whenever it likes while it keeps the tabs and the extension's debugger attachments, but the extension used to start a new state generation with every worker, so each such restart ended every browser session on the profile. The extension now keeps its state generation and the tabs it has attached in `chrome.storage.session`, which Chrome keeps exactly as long as those attachments. A new worker checks each recorded attachment with a debugger command that changes nothing, carries on with the ones that answer, and reconnects under the same generation, so the same browser session continues on the same tabs. An attachment an earlier worker left without recording it is taken over instead of refused. Reloading or updating the extension, or restarting Chrome, still starts a new generation and ends the sessions as before. Each time a worker carries on an earlier worker's state, the extension records how many attachments it kept, how many had ended and how many tabs were closed (`stateResumptions` in the extension's local storage, the latest 20).

  A command that was in flight when the worker stopped still reports its outcome as unknown, and nothing replays it. Each event poll now names the worker's event stream; browserd treats a new stream as lost event history and resynchronizes even when the new worker's sequence numbers have caught up with its cursor, and a tab whose input was in flight on the old worker can be used again once a new worker answers. Ending or leaving an attached session also no longer closes an empty tab that is still on its way to a page.

## 0.2.1

### Patch Changes

- 4b3f4b7: Closing the last tab of an attached Chrome profile no longer disconnects the profile. Chrome closes a profile with its last window, which stopped the extension and ended the profile's connection while Chrome kept running; the extension now opens a new tab page in that window before closing the profile's only tab. A new tab in a Chrome that is running with no window open (common on macOS) opens in a new unfocused window instead of failing. A tab close whose profile connection ends before the extension answers is reported as `outcome_unknown` (HTTP 409) telling the agent to list the tabs again, instead of an unexpected internal error, and a tab Chrome says is already gone is `target_not_found`. `interaction_discover` now shows the model a compact inventory: each BrowserSession and ComputerSession keeps what is needed to reuse it (id, name, lifecycle, placement, engine or platform, identity, last use, whether it belongs to this chat and the capabilities it lacks), and at most 50 sessions and identities of each kind, this chat's own first and then usable ones by most recent use, with a note naming how many were left out; the whole result stays within a fixed byte budget (768 KiB) and each session keeps only its association with this chat, so it never needs a spill. A large workspace used to produce a result of megabytes that the model could not read. Closing a tab that is already gone no longer makes the agent forget its current browser, and a close whose connection ends before the remaining tabs are listed is `outcome_unknown` too. Code Mode programs still receive every full record.

  A tool result too large for the model (over 1 MiB) is now always readable where the agent runs. Its receipt names the copy's absolute path on the machine it was written to (a Connected Machine's own folder or the sandbox's root), so it opens from any working directory; before the turn's sandbox has started it names the path the copy gets when it starts, instead of none; and a text line after the receipt says to read parts with the shell and, when there is no copy, to fetch the file by its id with `files_get_download_url`.

- ab5fcc1: Attached Chrome no longer loses a tab when another extension puts its own frame in the page, as password managers do for their inline menus. Chrome ends and refuses debugging of a tab that holds another extension's page, so the extension now removes those frames from tabs it controls (including inside closed shadow roots) and attaches again, using the new `scripting` permission with access to all sites; Chrome's permission warnings are unchanged because the debugger permission already covers all sites. When the page keeps adding the frame back, the tab fails with a clear error that names the password manager and says to turn off its inline menu for the site or use a managed browser. Each attachment now has a number, so a late command for an ended attachment is refused instead of reaching its replacement and a detach reported after its replacement attached no longer ends it; input that Chrome ends part way is reported as outcome unknown without making the tab unusable, and the extension accepts `Inspector.enable`, which browserd sends on every attach.

## 0.2.0

### Minor Changes

- 6c7b552: Downloads now work in attached Chrome. A file that a tab Opengeni controls downloads appears in `browser_downloads` like a managed browser's download, and `browser_download_save` saves it into the session's workspace. Chrome still saves it in the person's own downloads folder, where it stays untouched; the session keeps a verified copy. The extension asks for Chrome's `downloads` permission so it can tell where Chrome saved a controlled tab's download (it looks up only completed downloads of that address since the download began). With an older extension, such a download is listed as failed with `download_location_unavailable`.

### Patch Changes

- e142b9e: The browser extension now reconnects to the local agent after Chrome stops and later restarts its service worker. A periodic wake-up alarm (new `alarms` permission) reopens the native connection when it is down, so an attached Chrome no longer stays disconnected until a tab event happens. Browser and computer controllers also log the class, frame and redacted message of any dispatch error the driver did not classify, so `controller_lost` failures leave a cause in the agent log.

## 0.1.7

### Patch Changes

- 0ac4e98: A product can build the extension under its own name and icons: `scripts/build.ts --brand <file>` takes a brand file (names, summary, homepage, icons, optional manifest key), and `brand:icons` makes the icons from one mark. Every name a person sees comes from the brand; Opengeni Browser's own build is unchanged.

## 0.1.6

### Patch Changes

- 13b9837: The popup now says why it cannot reach the computer's agent instead of a bare "Agent unavailable": the agent is not set up on this computer, it is too old for this extension, it is not running, or it stopped. The raw browser error stays available on hover.
- 87b1e0e: When the extension and the computer's agent don't match, the popup now says plainly which side is outdated: "Update the Opengeni agent" (with the agent's version when it reports one) or "Update this extension". When the agent reports the extension as the older side, the extension checks for its own update right away and applies it, since nothing is attached while the agent refuses it. Current agents explain every refused connection (not running, older or newer bridge, or another error), so the popup no longer guesses between "not running" and "too old".
- cbb55f3: The extension popup now keeps its connection state current while it is open. It used to show the state from the moment it opened, so opening it while the agent was still starting or the native host was still connecting left it saying the agent was unavailable even after the profile connected.

## 0.1.5

### Patch Changes

- 615cc90: Apply a downloaded extension update without waiting for Chrome to restart. Chrome installs an update only when the extension's worker stops, and the native connection keeps it running for as long as Chrome does, so fixes (such as fast background-tab clicks) did not reach the browser until a restart. The extension now reloads itself into the new version as soon as no agent is driving a tab: nothing attached, or no agent command for 15 minutes, and never during a command.

## 0.1.4

### Patch Changes

- Report a state generation that stays the same for the extension worker's lifetime, across native reconnects. Agents that understand it keep the profile's attached browser sessions alive through agent restarts, agent updates and native-host reconnects instead of ending them; each native port is still fenced by its own connection generation.

## 0.1.3

### Patch Changes

- 2c2e03d: Keep an attached browser connected when its profile label changes. Publish the updated label in inventory without replacing the connection generation or invalidating active browser sessions and pending commands. Older extensions can continue sending tab-only inventory.
- 2952b97: Make clicks and hovers in attached Chrome fast again. Agent tabs open in the background so the user's foreground tab is left alone, and Chrome held every mouse event sent to such a hidden tab for about five seconds before acknowledging it, so each click cost over five seconds regardless of how many agents ran. Attached sessions now use the same target-local focus emulation as managed browsers, which keeps a background tab rendering and taking input without activating it; Chrome clears it when the debugger detaches. The extension admits exactly `Emulation.setFocusEmulationEnabled` and no other Emulation method.
- The packaged manifest version now comes from `package.json`, so Changesets owns the extension version and every package (unpacked archive and store ZIP) carries the same version.
