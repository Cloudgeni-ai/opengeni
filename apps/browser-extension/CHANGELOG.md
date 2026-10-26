# @opengeni/browser-extension

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
