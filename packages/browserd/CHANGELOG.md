# @opengeni/browserd

## 0.4.12

### Patch Changes

- 447e194: Streaming the live view of a tab in a person's own Chrome no longer changes how the tab looks. Each frame used to be a clipped screenshot scaled to the viewer's size, and Chrome takes a clipped screenshot by redrawing the tab itself at that size until it answers. On a 2x display, the tab the person was looking at shrank into its top-left corner on every frame (a blink several times a second). A tab Chrome was not drawing (behind another tab) never answered its capture, so the next frame's capture began on top of it, took the shrunken size for the tab's own and put it back last: the tab stayed drawn small until its window was resized. Frames of attached Chrome are now whole-viewport captures, which leave the tab untouched, scaled down to the viewer's size in browserd. For every browser, a capture of a tab is now sent only after the previous one is answered or its connection gives up on it (full-page screenshots included), within its own deadline, so a capture no longer begins on top of a slow one and leaves the tab at that capture's size. A live-view frame that finds a screenshot of the tab still running skips that round instead of counting as a failed frame, so a slow screenshot does not end the live view.
- 205b05a: Agents can now set camera, microphone, geolocation and notifications permissions in the person's own Chrome, for the exact top-level origin (scheme, host and port) of a tab the session opened and no other session is using; the person's own tabs are refused. The first such action opens a page in the extension where the person allows it once; until then the action fails with a short message saying so. The extension records every change and lists it in its popup with Remove, Chrome shows the settings as set by an extension in its normal site settings, and setting a permission back to prompt clears it. Other permission types, and extensions without this support, fail with a clear message. The browser_act description no longer says permission actions only work in managed browsers.
- de1ced7: In the person's own Chrome, a tab in front whose page does not answer, often because it opened a dialog (alert, confirm or prompt) while no agent was controlling it, no longer hangs every call for two minutes and then advises closing the tab. After the 10 second attach deadline the agent is told plainly that the page is busy or holds a dialog only the person can see, and that it can ask them to answer it or cancel it with `handle_dialog` dismiss. Nothing is switched or cancelled on its own. An explicit dismiss hides the tab for a moment behind a new blank tab (Chrome then closes such a dialog as Cancel), puts the tab back in front unless the person showed another tab meanwhile, and closes the blank tab. It reports the dialog cancelled only if the page answers right away afterwards; otherwise it says no dialog was found and the page is busy. Page commands in attached Chrome now time out after 30 seconds and attaching after 10 seconds, instead of waiting without a limit.
- e1ebd25: A browser session in the person's own Chrome that continues after being idle, or after its controller restarted, no longer opens a blank tab in the person's window when none of its tabs are left. It carries on in the tab it was using, or in another tab it opened that is still open, and otherwise has no tab until it opens one. Its tools then never pick one of the person's tabs by themselves: they say the session has no tab of its own and to open one, or to name one of the person's tabs. The API tells browserd it can take a session with no tab, so browserd and the API can be deployed in either order.
- aedf0d7: A click in a tab that is open in the background keeps its protection against landing on something else. Chrome can take seconds to acknowledge the pointer's move in a tab it is not drawing, and the guard that holds back a press landing on anything other than the target disarmed itself on a clock that started before that move. By the time the press arrived the guard was off: a layer that the pointer's arrival opened over the target took the click, and a submit click whose page was replaced before the driver read the guard back was reported as an unknown outcome although it reached its button. The guard's clock now restarts just before the press.
- c5e82ff: Browser Back now leaves a page that a sign-in or other redirect flow reached, instead of reporting success while the tab stays put. Back used to step exactly one history entry and count any commit as success, so two common shapes trapped it: an intermediate page that sends the tab on again as soon as Back shows it, and entries a page adds for the URL it already shows as it opens. Back now passes over an entry whose page goes on to another page by itself right after Back opened it (up to three such entries), and over entries for the current URL that the page added without any input, as Chrome's own Back button does. Entries made after input, such as a dialog that closes on Back, and entries with their own URLs stay single steps, and a page restored from the back/forward cache or one that reloads itself stays where Back left it. When every page Back could reach sends the tab on by itself, Back fails and names the page before them to navigate to instead. Forward is unchanged.
- d5586b3: Typing into a canvas that reads key presses, such as a remote-desktop viewer, now delivers the text asked for. `type` with `mode: "keys"` presses the key a person would press on a US keyboard for each character, holding Shift for uppercase letters and shifted symbols, and a modifier in `press` (for example `Ctrl+C`) now goes down as its own key before the main key and comes up after it, also when sending the key fails. A digit or symbol in `press` is its US key too (`!` is Shift and the 1 key), and a letter in a key combination is reported lowercase unless Shift is held (`Ctrl+A` sends `a`), as a browser reports it. Viewers that forward physical keys (scancodes) used to get lowercase letters and unshifted symbols, and symbols with no key at all were dropped.

  Characters with no key on a US keyboard (such as `æ` or `é`) are still sent as text only. A text field takes them, but a canvas that reads key presses may not, so when one is sent while focus is not on a text field the result is `outcome_unknown` and names those characters.

  `type` without `mode: "keys"` inserts text, which Chromium silently drops when focus is not on a text field (a canvas, a button, a grid cell that is not being edited, or the page itself), while the action reported success. It now fails as `invalid_action` before anything is sent, saying to focus a text field or use `mode: "keys"`. With a locator, the target is checked before it is focused; an element that holds a text field (a wrapper that moves focus into its field) is decided by where focus lands. Code editors that take text through EditContext (Monaco, VS Code for the web) count as text fields.

- 4289206: `check` now works on whatever observe shows as a checkbox, switch or radio button. A located element stands for the control it is or sits in, up to the nearest label, and a label (or text in it) stands for the control its `for` names, or else for the one checkable control it wraps, such as a box drawn with an ARIA role or a hidden input beside the label's box; a label wrapping more than one control stands for none. A native input that is not rendered, hidden or clipped away is checked through its label, never through a link in it. ARIA roles and `aria-checked` are read in any case, a checkable role after one the browser does not know counts, and a custom element that sets its role and state through `ElementInternals` is read from the accessibility tree. A disabled or `aria-disabled` control is refused at once. A box in the mixed state counts as neither checked nor unchecked, and `check` completes only when the box shows exactly the state asked for. A target that is none of these is refused with a reason that says to click it instead.
- 12613a5: A `permission` browser action that set the permission and then lost its tab (a refused reattach or a tab that stopped answering) is now reported as `outcome_unknown` instead of `failed`, because the permission may already be set. The browser's own refusal of a setting is still reported as `failed`.
- d4fd76d: A managed browser that was stopped (for example after going unused for 10 minutes) and relaunched now tells the agent so on the tabs it reopened. Chrome reopens those tabs at the same URLs and they keep their IDs, but each page loaded again, so text typed into it, a dialog it had open and anything else it held only in memory are gone. Before, nothing said this: an agent that came back to the tab saw an emptied page with no explanation.

  The first observation of a reopened tab that the agent's own tools receive (browser_observe, the page after a browser_act, or a tab selected with browser_tabs) now carries a new optional `notice` field on `BrowserObservation`, shown to the model right after the tab line, for example: "This browser was stopped after going unused for 10 minutes and relaunched on its next call, so this tab's page reloaded: anything typed, selected or opened on it before then that the page did not save is gone." It is given once. Nothing is refused because of it: an element reference from before the reload already fails as stale, and anything else the agent does runs on the page as it now is, with the notice in the result. A caller receives notices only when it asks with the new `notices=1` query parameter (`BROWSER_OBSERVATION_NOTICES_PARAMETER`), which the API sends only for an agent's own requests, so a person watching the browser, an auth check or an API client neither sees the notice nor uses it up. Browser controllers that predate it ignore the parameter, and callers that do not send it never receive the field.

  Every tab a relaunched browser reopened now answers. Chrome loads the pages of only the first few tabs it restores and leaves the rest without a renderer until they are used, which browserd reported as "This browser tab crashed", so with five or more tabs the later ones could not be used after a relaunch. browserd now starts such a tab's page the first time it is used, in the background and without switching to it, and waits briefly for it to load.

  A tab showing the browser's error page (its last load failed) now also keeps its ID across a relaunch. Chrome reopens such a tab at the address it failed to load, not at its error page, so browserd now records and matches it under that address, read from the tab's history when the browser stops. Before, the tab was reported as replaced and reappeared under a new ID. Tab lists still show the error page's URL while the tab shows it.

- f3813b6: A screenshot of a tab that has not drawn yet, such as one a relaunched browser has just restored, used to fail as an internal error, because Chrome refuses to capture such a tab instead of waiting. It now waits for the tab to draw, and if the tab never draws it fails as a plain, retryable screenshot timeout.
- f4c1125: On macOS, choosing an option of a dropdown no longer opens or leaves open its menu in a window behind the person's. Invoking an option of a dropdown (an item of its open menu, or the option a closed browser dropdown shows) chooses that option on the dropdown, as `set_value` does, instead of pressing the item: a browser dropdown took such a press as a choice and opened its menu again, raising its window, and a closed one's option could bring the browser down. `set_value` on a browser dropdown in a background window of the front browser now types the option's text instead of opening the menu, a menu still open after a choice is closed, and a pointer click on the option a closed browser dropdown shows is refused like one on the dropdown. A dropdown in a window that is already in front opens its menu instead of being refused, and an ARIA menu button (whose menu is drawn in the page) is no longer refused as a browser dropdown; the refusal that remains names `set_value`, and the window's own `focus` action with its target to open the menu itself, only when that focus would bring the window forward (not while someone else is using the computer). An option with no text to choose it by is refused in the background instead of pressed. A native combo box reads as a `combobox` that takes `set_value`, and its app takes the new value as chosen.

  Pins CUA 81cf0b7f.

- 0c12991: Clicks in a browser tab hidden behind another tab, without focus emulation, reach the page or fail plainly, and no longer take about five seconds:

  - Chrome dropped the press of a click (and other non-move input) in a tab opened in the background that had never drawn, yet acknowledged it, so the click was reported done while the page got nothing. Before the first input to such a document, the driver now has the tab draw itself with a one-pixel capture, without showing it or taking focus. If the tab still cannot draw, the action fails before any input with a message saying the tab is hidden and should be activated first.
  - The press no longer waits out Chrome's roughly five-second hold of the pointer's move to a hidden page. Sent right after the move, it has the page take the move and run its handlers first.
  - The click guard stays armed until it has judged the press, however long the page's handlers for the pointer's arrival take, instead of disarming five seconds after it was set up. A guard that saw no press (the press went to another document, such as a frame that appeared over the target) or ran out of time before it no longer lets the click count as delivered; the outcome is reported as unknown.

- 0777816: A browser live view now comes back by itself after its page was busy for a while. A page whose main thread is busy answers none of the commands a frame needs, and three frames that timed out (about 6 s) used to end the frame stream for good, so a page busy for longer froze the live view for the rest of the session even after it became responsive again. Frames that time out no longer count toward ending the stream: it keeps sampling the tab and shows it again as soon as the page answers. The same holds for a tab its browser is not drawing yet, such as one behind another tab in a person's own Chrome. The stream still ends when its tab closes, its browser goes away, or frames keep failing for any other reason.
- 0ba40f0: On macOS, typing into a browser's address bar in the background and pressing Enter now loads the page. The text used to be written through accessibility, which the address bar shows but never takes, so Enter loaded nothing while the batch reported success; it is now typed with keystrokes the browser does take. A `computer_act` batch whose raw input (a key press, or a press the driver could only send) went unconfirmed and that changed no element now says it may not have taken effect, as a single action does. Computer sessions report `targetFocus`, whether a focus action can bring a window forward, and `computer_open` lists "window focus" under what is not available where it cannot (CUA on Windows and Linux).

  Pins CUA 944b1b7f (cu-browser-field-keys merged with cu-popup-options).

- 63c0865: Typing with `mode: "keys"` into split one-time-code boxes no longer drops characters on a busy machine. Between characters, a visible tab now waits for its next frame for up to a second. Before, it gave up after 50 ms, and when the frame came later than that, the next key went to the box that was already full. Hidden tabs, which draw no frames, still wait only 50 ms.
- 5cab358: Preserve WebAuthn backup eligibility and backup state when importing vaulted passkeys into managed Chromium. Bitwarden, Vaultwarden and Proton Pass passkeys now retain the flags their authenticators used at registration, preventing relying parties from rejecting an otherwise correctly signed assertion. Hosted registrations retain their own flags. Negotiate flag support before sending it, keeping older controllers and APIs compatible with the original sync format.
- 266f31e: Windows computer use now reports CUA's text-only value-pattern refusal as definitely not dispatched, rather than an unknown outcome, and tells the agent to click into the field and type instead. CUA does not expose the selected element's native control identity, so browserd does not bypass that refusal by guessing a control from its rectangle. This also avoids unverified password writes and casing-based guesses about masked contents. Classic Notepad fields refused by CUA still require the click-and-type path; successful CUA value writes are unchanged. A window's title bar no longer offers `set_value`, since its value is its title and cannot be set.
- 6e2280a: Text typed on Linux X11 no longer loses or repeats characters the keyboard layout lacks (such as `ø` on a US layout or `密`) while reporting them as typed. Spare keycodes bound to such characters now stay bound for the rest of the session instead of being restored right after the action, so an application that reads the new keymap late still gets the right text; they are restored when the last session using them ends, or on the next session start after a crash. Function keys the layout lacks (F13 to F24) use the same bindings. Only when a batch needs more distinct characters than spare keycodes remain is ordinary text pasted, and the person's previous clipboard text is put back once the target has read it (it stays replaced when it held something other than text or the target did not read the paste within three seconds). A secret the layout cannot type is refused without naming the character or suggesting the clipboard.
- Updated dependencies [e1ebd25]
- Updated dependencies [44ba53b]
- Updated dependencies [d4fd76d]
- Updated dependencies [f385091]
- Updated dependencies [7a5395e]
- Updated dependencies [12b773f]
- Updated dependencies [7f627c9]
- Updated dependencies [e8bc121]
- Updated dependencies [ecc876a]
- Updated dependencies [f6c6c0f]
- Updated dependencies [09972b5]
- Updated dependencies [cebc433]
- Updated dependencies [0ba40f0]
- Updated dependencies [37538aa]
- Updated dependencies [c6ba725]
- Updated dependencies [5a3ed41]
- Updated dependencies [a02dca4]
- Updated dependencies [a1a060b]
- Updated dependencies [60c6c56]
- Updated dependencies [177de8d]
- Updated dependencies [d166d88]
- Updated dependencies [66d1e08]
- Updated dependencies [6c5a6b5]
- Updated dependencies [21856c5]
- Updated dependencies [4b0dd0b]
- Updated dependencies [3c0113c]
- Updated dependencies [71bcf11]
- Updated dependencies [942fcc1]
- Updated dependencies [fb41dfd]
- Updated dependencies [31e07a6]
- Updated dependencies [a744c56]
- Updated dependencies [a895f0b]
- Updated dependencies [b0f7062]
- Updated dependencies [670913f]
- Updated dependencies [3aaf6ed]
- Updated dependencies [0f77b2d]
- Updated dependencies [77f483f]
- Updated dependencies [a1e75dc]
- Updated dependencies [5cab358]
- Updated dependencies [35387c2]
- Updated dependencies [149a15c]
  - @opengeni/contracts@6.0.0
  - @opengeni/interaction@6.0.0

## 0.4.11

### Patch Changes

- a6b3a97: A browser session in the person's own Chrome that ended because that Chrome reconnected (Chrome or its extension restarted) no longer answers every later call with "Only a suspended BrowserSession can be resumed". Such a session has no saved working copy, so the tools no longer try to resume it. `browser_observe`, `browser_act` and `browser_tabs` say it ended and that `browser_open` with its ID continues, and `browser_open` with its ID continues in the same Chrome profile: it reuses the chat's live session there or opens one, and its result names the new session ID.

  In the person's Chrome, the empty tab a session opened now closes as soon as the session moves to another tab, instead of staying until the session is released or ends. Tabs the session did not open, tabs showing a page and tabs another session uses are never closed.

- 1a4e2ec: Attached Chrome keeps working in a tab while a password manager shows its inline menu. Chrome ends the extension's debugging of a tab as soon as another extension's frame starts loading in it, and while that frame loads it can refuse every command on a new attachment without running it. The extension now removes those frames and sends a refused command again once (never onto a different attachment). Commands refused together for the same frame share one removal, so they count once against the existing limit on how often the extension removes frames, and only Chrome's actual refusal starts a removal. A removal the page does not answer within a few seconds is given up rather than holding up the tab, and a frame added back right after the removal a refusal reused is removed once more. A frame that keeps coming back fails with the existing error that names the password manager and says what to do.

  browserd now treats Chrome's "Debugger is not attached" answer as the end of that attachment instead of an unclassified error, so the next call attaches again. Observations, tab state, page reads and screenshots whose attachment ends part way are read once more on a new attachment. An action whose attachment ends after input was sent is `outcome_unknown` with a fresh observation of the tab on the new attachment, so the agent can see whether the input landed; an action that ended before any input stays a definite `failed`. Chrome also gives its other-extension-frame refusal for a tab it is about to stop debugging, so with an extension that relays that refusal as is, the first one ends the attachment the same way; only a refusal that persists on a new attachment is a definite failure that says what to do, rather than a retryable error that never cleared. The tab state and page read routes of browserd no longer answer a lost attachment with a 500.

- c3aa91c: Attached Chrome sessions now survive a restart of the extension's background worker. Chrome stops and restarts an extension's worker whenever it likes while it keeps the tabs and the extension's debugger attachments, but the extension used to start a new state generation with every worker, so each such restart ended every browser session on the profile. The extension now keeps its state generation and the tabs it has attached in `chrome.storage.session`, which Chrome keeps exactly as long as those attachments. A new worker checks each recorded attachment with a debugger command that changes nothing, carries on with the ones that answer, and reconnects under the same generation, so the same browser session continues on the same tabs. An attachment an earlier worker left without recording it is taken over instead of refused. Reloading or updating the extension, or restarting Chrome, still starts a new generation and ends the sessions as before. Each time a worker carries on an earlier worker's state, the extension records how many attachments it kept, how many had ended and how many tabs were closed (`stateResumptions` in the extension's local storage, the latest 20).

  A command that was in flight when the worker stopped still reports its outcome as unknown, and nothing replays it. Each event poll now names the worker's event stream; browserd treats a new stream as lost event history and resynchronizes even when the new worker's sequence numbers have caught up with its cursor, and a tab whose input was in flight on the old worker can be used again once a new worker answers. Ending or leaving an attached session also no longer closes an empty tab that is still on its way to a page.

- 152633f: A browser click, double-click, hover or drag that first scrolls its element into view now waits for the page to finish reacting to that scroll before it aims. Pages often change layout once they scroll (a sticky header that shrinks, directly, on the next frame or after a short debounce), which moved the element after it was measured, so the press landed on whatever took its place and the click was refused as covered at its center although nothing covered it. The driver now waits until the element's box has not changed for 150 ms of drawn frames, counted from the first frame after the scroll, or for at most 600 ms while it keeps moving; a busy browser whose frames come slowly is given until it has drawn two frames, at most 1.5 s by the driver's own clock. The wait runs in an isolated world, so page scripts that replace their timers or frame callbacks cannot hold it, including during a drag with the button held. An element already in view, which needs no scroll, and a hidden tab do not wait. When the press still falls outside the element's own box (for example the pointer's arrival collapses the panel above it), the refusal now says the element moved, names what the press fell on, says the click was not delivered and that it can be clicked again; a press inside the element's box that something else takes is still refused as covered at its center. When the page removes or replaces the element while the driver waits (a list that renders its rows anew as it scrolls), or hides it, nothing is pressed and the click is refused as no longer present, or as having no box on the page, instead of failing with the browser's raw "Could not compute box model." error.
- fa7516a: A full-page browser screenshot no longer changes the page's layout. Chromium hides classic scrollbars for a capture beyond the viewport, so content used to widen by the scrollbar's width while it was captured, right-aligned elements moved, and the change stayed after the capture; the image was also narrower than the tab's viewport. The capture now keeps each scrollbar's space with a temporary inspector stylesheet that page scripts cannot see, re-evaluates scrollbars afterwards, and is as wide as the tab's viewport. Screenshot scale now comes from the emulated device scale factor instead of the image width, which excluded the scrollbar. When some scrollbars cannot be kept (horizontal ones, ones inside shadow trees), the browser_screenshot result and Code Mode screenshot metadata carry a short `note` saying so, and the SDK frame has `inexactScrollbars: true`.
- 6f158a4: A managed browser no longer signs in to an account by itself through a saved passkey. Each tab's virtual authenticator holds the passkeys its user may use and answers requests without a person present, so a sign-in page that asked for passkey autofill on load (a conditional `navigator.credentials.get`, which many identity providers send on their account-chooser and identifier pages) was answered at once with a saved passkey. A fresh browser, even one with a new or empty identity, was then signed in to that account before anyone chose it, and "use another account" or signing out signed it straight back in.

  Tabs and their frames, including cross-site frames that share the tab's authenticator, are now told that passkey autofill is unavailable, and an autofill request stays pending until the page cancels it, as it would in a browser where nobody picks a passkey. A passkey is still used when the page asks for one in the open, for example after a "Sign in with a passkey" click. A tab that cannot take this is given no authenticator.

- f23588a: A browser tab resized with the `viewport` action can now be returned to its window's own size and scale with the new `viewport_reset` action. It ends the tab's device-metrics and touch emulation, so later observations and screenshots show the window's real size and device scale factor again, and tabs that open afterwards are no longer given the size set before. Tabs that already took that size keep it until they are reset themselves. Setting a tab's observed size back with `viewport` is not the same on a display whose own scale is fractional: the window is then a fractional CSS size, observed rounded, and Chromium lays an emulated size out in whole display pixels at an emulated scale of 1, so it can come out a pixel off; `viewport_reset` restores it exactly. In a person's own Chrome, which never admitted viewport emulation, both actions are refused plainly as unsupported without sending anything to the tab.

  `viewport` and `viewport_reset` also take, and stay, while someone watches the tab live. The live view samples the tab with clipped screenshots, and Chromium changes the page's emulation for each capture and then puts back what it saw when the capture began, so a change that landed during a capture was undone a moment later, and a reset could leave the tab stuck at the old emulated size even after the view closed. Both actions now hold that tab's frame sampling off while they apply, waiting for a capture already running, and then check what the page reports: the set screen size after `viewport`, and the tab's own size and scale after `viewport_reset`. A change that still did not take is sent once more and otherwise reported as an unknown outcome that asks the agent to observe the tab, never as a success.

  The same holds for a capture that is still running after the live view has closed, and for background tabs, which is where agents open their tabs. A background tab reports no window size of its own, which used to make the check skip itself and report success, and it did not lay out again after a reset until it was shown, so it stayed at the emulated layout size. The check now reads the window size from the browser, and a reset has the background tab draw itself once at its own size without showing it or taking focus. The page's size is read where page scripts cannot change it, and a page that cannot be read does not count as confirmation.

- 1600e2d: A managed browser, or an attached Chrome's debugger connection, is no longer stopped as idle while the agent session that created or is using it is still working (a turn queued, running, recovering, waiting for capacity or waiting on a person) or deliberately waits (`wait_for_input`). Every two minutes the API lists the browsers held this way (`listAgentHeldBrowserSessions`, migration `1002_browser_wait_hold`) and renews a short hold on each running browser's controller (`POST /v1/browser-sessions/:id/wait-hold`, `BrowserControlClient.holdForWait`): keep it at least five more minutes. A hold only ever extends, so overlapping renewals from several API processes are harmless and nothing needs to end one; once the session neither works nor waits the renewals stop, the hold lapses and the normal idle time counts from its end. The idle release keeps the browser, tabs and page state, but never longer than `BROWSER_WAIT_HOLD_MAX_MS` (60 minutes) after the browser's last use, so a long turn or repeated waits cannot keep a browser nobody uses. Renewals reach a Connected Machine or attached Chrome as the person who most recently started a turn of the holding session, through the explicit `browser.hold` operation with no request grant; a browser held only by sessions no person started is renewed only through a sandbox's cached controller endpoint. A browser held at controller shutdown is handed off and kept by the successor, and a renewal after a restart keeps a handed-off browser the new controller has not adopted yet. A sandbox box holding such a browser is not released as idle under the same rule. A renewal never launches, recovers or counts as a use of a browser and never starts a sandbox; a controller that predates it keeps its plain idle release. Browsers that only observed, and browsers no working or waiting session holds, are released as before.

  `list_agent_held_browser_sessions` ships with its runtime `EXECUTE` withheld for one release (`DEFERRED_RUNTIME_PRIVATE_ROUTINES`), because the previous release's readiness rejects a runtime grant on a SECURITY DEFINER routine it does not know. Until a later migration grants it, the API lists nothing and renews no controller holds; the sandbox box release applies the rule from this release on.

- 6b24049: Computer use on a Mac no longer refuses with "Another user's session is on this Mac's screen" while this user's session is on screen and a second user is logged in in the background. The console check took the owner of `/dev/console` as the user on screen, but that device belongs to whoever last logged in at the console. It now reads whose session is on the console from the IORegistry's `IOConsoleUsers` (and that session's lock, with `IOConsoleLocked`), falling back to `/dev/console` only when the registry cannot be read. A switch to another user, a locked screen and the login window are refused as before.
- e555018: On macOS, a window named by its id (`cua:window:<pid>:<window>`) is a computer-use target while its app lists it on any window level, so a dialog an app raises above its working windows can be observed as well as read, and a target missing from the last listing is looked up again before it is reported gone. An element invoke the driver cannot confirm, with nothing changed after it, now gets the same "may not have taken effect" line as an unconfirmed click: some toolbar buttons that open a flyout ignore an accessibility press while their app is in the background.

  A failed read of a window still on screen (a tree read or capture CUA answers with text only) is tried once more, and a second failure is refused as unavailable with what to do next, instead of an internal error; a window that closed meanwhile is reported gone. On macOS, computer listings and observations say when someone other than Opengeni used the keyboard, mouse or trackpad within the last minute (`personInputSecondsAgo`), from timers that input agents send to apps in the background does not reset; input Opengeni sent in the foreground through this computer is told apart and not reported. An accessibility action macOS answers with "cannot complete" (-25204) is checked against the windows afterwards, as -25205 already was.

  Pins CUA 24a0726f: an accessibility press the app answers with "cannot complete" counts as done when its window closes within a second.

- 3aa5f2c: On macOS, a computer-use batch whose earlier action closes or hides its window (a start screen's Cancel) can still open the app's menu in a later action: an accessibility action on an item of the app's menu bar no longer depends on the batch's window. A later action on an element of a window that is no longer on screen is refused before anything is sent, reported as not run rather than with an unknown outcome, and the refusal says to act on one of the app's windows that is shown. A later action looked up by role and name in such a window fails the same way at once, instead of after its whole wait. A focus action on a macOS window now brings it to the front and confirms it there, instead of being unsupported, except while someone other than Opengeni used the keyboard, mouse or trackpad within the last minute: then it is refused before anything is sent, saying to ask them first or keep working in the background.

  Pins CUA bc18cf52 (`cu-menu-bar-after-window-closes` merged with `cu-office-menus` 24a0726f).

- 0efac58: On macOS, Return or Enter sent to a window of a background app whose sheet holds the focus (an alert, a prompt) now presses the sheet's default button, as it would in the foreground. The posted key alone reached the sheet but never its default button, since the app looks for that key through its key window, which a background app does not have. The press goes through accessibility and does not bring the app forward; it is confirmed when the sheet closes. An ordinary window keeps the posted Return, which its fields, combo boxes, tables and search fields handle themselves.
- bcf968a: On macOS, keys based on a reading the app did not answer are refused even after a later reading has answered, since the reading they name showed no focused element. `set_value` now tells a web `<select>`'s open menu by the item the menu marks as chosen rather than by its highlighted item, which the pointer or arrow keys can move over a neighbouring select, and when it opened a menu and then refuses, it closes that menu even if it could not tell it for the select's. Finding the read window no longer asks for more window numbers once its deadline has passed.

  A sheet takes background keys for its window when the app's focused element is the sheet or lies in it (its top-level element is the sheet), as for a prompt's text field or an alert with only buttons, while a file panel whose contents another process serves shows no focused element and stays refused whatever it calls itself. When the app names no focused window, the keyboard refusal says the focus is unknown instead of naming another window. Each reading of an app's focus before background keys has one second in all, so an app that stopped answering cannot hold it for a messaging timeout per request. A window that once proved to be an unreadable sheet stops counting as one when it closes, goes off screen, no longer lies within another window of its app, or reads. When `set_value` closes a menu that outlasted its cancel, Escape is sent only while a menu window it opened is still on screen, and a refusal says when such a menu may still be open.

- 22b129b: On macOS, the controls of a web page in Chrome or another Chromium app can be invoked again: Chrome lists no press action on page elements in the accessibility mode Opengeni enables, so buttons, links, checkboxes and similar page controls showed no actions and invoking them was refused. Selects still take set_value. A pointer click on Chrome's own window controls, such as a background tab, is now sent as a pixel click instead of being reported as done while nothing happened. A keyboard shortcut whose menu item macOS keeps disabled while the app is in the background (Terminal's Close Window) reports that it most likely did nothing, instead of completing.

  Computer action receipts gain an optional `unconfirmedInput` field: the action's click or key press was delivered without any confirmation that the app acted on it. Controllers return it only to callers that ask with the `receiptUnconfirmedInput` query parameter. When it is set and no element changed, the agent's result says the input may not have taken effect.

- 0672bf0: On GNOME Wayland, typed text is checked the way Mutter resolves it: in the active keyboard layout group and at any level Mutter can reach with Shift or AltGr. AltGr characters such as `@` on a German layout are now typed instead of refused, and Latin text is refused while a non-Latin group such as Russian is active, instead of being silently dropped. Key combinations whose key only another group has, such as Ctrl+C while Russian is active, are pressed on the physical key that gives it there, the way a person's shortcut works, instead of being reported as sent while the key was dropped. On GNOME 49 and later the active group comes from Mutter itself; on older versions text must be typeable in every group, and a shortcut key that is not in every group is pressed as its physical key. Typing waits for Xwayland to take the session's keymap, so the first text after Xwayland starts is no longer checked against its default layout.
- b47983c: Typed text on Linux now arrives in the requested case while Caps Lock is on, instead of in inverted case while reported as sent. On GNOME Wayland (version 49 and later, which reports the locked modifiers) and on X11, each letter is sent with or without Shift so that Caps Lock turns it into the requested case; a character that cannot arrive as requested under the locked modifiers, such as a small letter while Shift is locked on GNOME, is refused with the existing "use clipboard paste" message. The Caps Lock state is never changed.

  On X11, typed text also follows the active keyboard layout group: with a second layout such as Russian active, Latin text no longer arrives as the letters on the same keys in that layout while reported as sent. Text is typed on the keys that give it in the active group, or on a temporarily bound spare key, or refused with the same message. If the keyboard state cannot be read while a lock or another group is active, typing fails with the existing retryable "keyboard layout is not ready yet" message instead of sending unchecked text. On GNOME, Caps Lock stays known across a keyboard layout change.

- Updated dependencies [23fb6ef]
- Updated dependencies [f23588a]
- Updated dependencies [1600e2d]
- Updated dependencies [e555018]
- Updated dependencies [22b129b]
- Updated dependencies [a4b57e6]
- Updated dependencies [729329e]
- Updated dependencies [e473f84]
- Updated dependencies [4a86d4d]
- Updated dependencies [220c431]
- Updated dependencies [d569481]
- Updated dependencies [8382bdb]
- Updated dependencies [fbcc3cd]
- Updated dependencies [18c7cfa]
- Updated dependencies [b1673ab]
- Updated dependencies [b56bf3f]
- Updated dependencies [031e173]
- Updated dependencies [81502bb]
- Updated dependencies [9c8a5d5]
  - @opengeni/contracts@5.5.0
  - @opengeni/interaction@5.5.0

## 0.4.10

### Patch Changes

- bd7b9cf: Attached Chrome now reports a tab that Chrome will not let the browser extension debug as a definite failure that says why and what to do, instead of a retryable "browser observation unavailable" that reached agents as "The workspace is temporarily unavailable — retry." The common case is a sign-in page where a password manager has added its inline-menu frame: older extensions relay Chrome's raw refusal, which now becomes guidance to update the extension, turn off that inline menu for the site, or use a managed browser; newer extensions' own explanation is kept word for word. Another debugger holding the tab (DevTools, or a racing attach) is a retryable `operation_conflict` that says to try again or close DevTools. Any other refusal names Chrome's reason, bounded to 300 bytes, and a tab that is gone (in either Chrome wording) is `target_not_found`. Lost connections and timeouts stay retryable.

  The same refusal on screenshots, tab state (activate and the action fence) and actions (click, fill, type, press) is no longer an unclassified 500, and an action refused before any input was sent is a definite `failed` receipt rather than an unknown outcome.

- 632f868: Screenshots of a managed browser tab that is not in front no longer stall for 10 seconds and time out. Every managed Chromium launch, headless or headed on any platform, now copies a freshly repainted surface for captures instead of waiting for a redraw that Chrome never shows for a tab another tab covers. Captures stay target-scoped: no tab is brought to front and the window's active tab does not change. In a person's own connected Chrome, which cannot take that launch switch, a viewport capture of a covered tab that Chrome does not draw now stops after 3 seconds with a plain reason naming browser_tabs and browser_observe, instead of waiting out the whole capture deadline.
- 9db3491: One oversized or unparseable Chrome DevTools Protocol message no longer ends the browser connection and every tab with it. The connection's socket takes frames of any size a page can produce (Bun's global WebSocket errors the socket above 128 MiB), and a command response over the 32 MiB message bound (or not valid JSON) rejects only its own command with `CdpResponseRefusedError`, matched by its top-level id in any key order; the controller reports it as a plain `invalid_action` that says the reply was too large and what to ask for instead. An event over the bound is dropped, counted and logged as `cdp_message_dropped`, and a recording whose screencast frame was dropped restarts its screencast. Very large pages are read within bounds: a document whose whole accessibility tree is too large for one message or one observation is read again node by node within a budget of 8,000 nodes, keeping the page's structure and a window of each long list around what is on screen (widened to fill the budget), so scrolling brings other parts into the outline. Pages that fit are read whole as before. Such a snapshot carries `incomplete: { reason: "node_budget", unreadCount }`, the browser agent view gets `unreadNodeCount`, and the outline text adds one line saying it is partial and how to reach the rest.
- d1f53db: A browser click or hover on an element that runs past the clipped edge of a panel holding it (a long tree row or label in a narrow side panel) is no longer refused as covered by whatever sits beside that panel, such as the main content group. The element's center lies past the panel's edge, where the panel beside it is on top, but that panel is not over the element: the browser's own hit stack leaves the element out there. The driver now clicks the part of the element that shows, at its middle. A real cover over that middle is still refused, naming it with "where it shows"; an element covered at its center, including one in the top layer such as an open popover, keeps the "at its center" refusal, as does one the page shuts out of pointer input with something over it (behind a native modal dialog, in an inert page, or under a modal library's pointer-events: none on the body); and an element wholly past the edge gets a refusal that says so. The cover's name in these refusals is now at most 160 bytes of UTF-8 and never splits a character.
- 0c10fb8: A browser click or hover on an element whose center is outside the window or a container's clip (for example a header link the page slides up while its content scrolls) now lands on the part of the element that still shows, instead of being refused as "covered or not pointer-actionable". That part must reach the element itself, not a separate control nested inside it (a card's own Delete button), and it stays inside the page's window, also from inside frames. Rotated, skewed or mirrored elements are not sampled this way. When nothing else covers the element but it still cannot take the pointer, the refusal now says why and what to do: only a nested control shows, it is out of view with nothing at its center, it is out of view with only its own container there, or it has `pointer-events: none` (often disabled). Refusals that name a covering element are unchanged, and the old generic text remains for any other case.
- 9721625: A CSS, test id or placeholder locator whose page navigates while it is being looked up no longer reports a valid selector as invalid; the lookup reads the new document, so a fenced action reports `document_stale` and a later batch action follows the page.
- 4488c59: Browser actions no longer report an ordinary page error as a lost controller (`controller_lost`). A dispatch error the driver did not classify is `controller_lost` only when the browser or the connection to it is actually gone; when the browser still answers, or does not answer a short check in time, it is `driver_failed` with an unknown outcome and a message that says which. Inside a browser action, such an error is a definite `driver_failed` failure when no input was sent, and an unknown outcome that names the error once input was sent. When every action ran but the page could not be read afterwards (for example a page whose frames keep changing), the receipt is `completed` without an outline and carries a new `observation_unavailable` note saying so. Clicking an option of a native single-choice dropdown now chooses it, as a person would: the page sees input and change, and an open list then closes without a blur or focus event. A disabled or hidden option is refused. A selection change whose change handler opens a JavaScript dialog, from a click or the `select` action, is no longer reported as an action that did not run. Clicking any other element the page does not render is a definite `invalid_action` refusal, and one removed from the page is a stale-element `locator_not_found`. Receipt notes are now versioned: a caller asks with `receiptNotes=2` (`BROWSER_ACTION_RECEIPT_NOTES_VERSION`) to receive the new note kind, and older callers keep receiving only the kinds they parse.
- 5a48fe7: Long text in a browser page can now be read in full. The outline says how long a clipped name, description or value really is (`valueChars=7089`), keeps the ref on a clipped text line, and notes once that `browser_read` mode=dom with that ref reads the rest. DOM element reads take `offset` and allow up to 32,768 characters per read; a truncated read returns `nextOffset` to read on. Clipboard copy of an element with no `content` now copies its selected text or, when nothing is selected, all of what it shows; before, it silently copied nothing. `content: "value"` works on custom text boxes (role=textbox and editable content), and a copy that finds nothing to copy says why and what to use instead, rather than "browser clipboard source is unavailable". Clipboard copy now withholds what DOM reads withhold (password, one-time-code and payment fields, hidden inputs, private content and containers holding them), a read page never splits a character, and a copy over the clipboard limit says to read the text in parts with `browser_read` mode=dom and `offset`.
- 3ee89da: Browser navigation now completes only once the new page has committed, and a page that never stops making requests no longer counts as network idle. Before, `navigate` could return while the tab still showed the previous page, so the next action could find and press its element in the page being left, and `waitUntil: 'network_idle'` reported success after waiting out its full timeout on pages that poll continuously. Now navigate and history steps wait for their own commit (and stop a navigation that never commits), and the outline, URL and screenshot of a result always describe the same document. A network-idle wait on a page that loaded but never went quiet still ends at its timeout and lets the batch carry on, and the action receipt now says so in a new per-action `notes` entry (`kind: "network_busy"`) instead of implying an idle network; a page that never loaded still fails the wait. When the page moves to a new document after an action found its element and just before its first input event, the action looks for its element (named by role, text or another non-ref locator) once more on the new page within its own deadline, and is refused without input only if the element is not there or the page changes again; actions in a fenceEachAction batch, and actions still waiting for their element, keep acting only on their own document as before. A navigation the browser turns into a download ends at once.

  A server that answers with an HTTP error status and no body is now treated like one that sends an error page: the tab shows the browser's page naming the status, and navigate, tab open and browser open complete on it. A browser whose first page fails to load still opens and shows the browser's error page instead of failing the whole open, with a plain line naming the load error, and a navigation that fails to load reports its failure with the error page the tab actually committed.

- 4302fe7: Browser scrolling reaches the panel that holds the content in fixed layouts. A located scroll on an element that cannot move (for example a details region inside a page that never scrolls) now scrolls the scrolling panel under that element's centre, then its ancestors as before, then the largest visible scrolling panel inside it, instead of refusing with "nothing at this element can scroll further". A page scroll on a page that cannot move does the same for the panel under the viewport's centre. Form fields are not treated as panels. The page outline marks visible scrolling panels with the directions they can still scroll, for example `generic [ref] scrollable=down`, and lists their refs, so an agent can target the right panel first; pages without inner scrolling panels are unchanged.
- 746b919: A browser `network_idle` wait now settles on pages that are done loading instead of waiting out its 30-second limit, and still waits for real loading. Requests made by cross-origin (out-of-process) iframes, by dedicated workers (including workers started by workers) and by shared workers are now tracked, so their documents and scripts count as finished when they finish. Requests the page's content never waits for no longer count: beacons and link pings, CSP reports, prefetches, media streaming, the manifest, the browser's own icon fetch, and blob: and data: URLs. A response whose body has had no data for 3 seconds, and a request with no response after 10 seconds (a long poll), stop counting, so a slow download or a streamed answer that keeps sending still counts. When one of those two cutoffs is what let the wait end, the action receipt says so in a `network_busy` note. The 30-second limit and the existing note for a page whose network never went quiet are unchanged. The short settle after a click or other action uses the same rules.
- 2a181e7: A managed browser's tabs now keep their IDs when the browser is relaunched, and a call naming a tab that no longer exists says why it is gone and how to carry on, instead of only "browser target does not exist". Tab IDs used to be the browser's own target IDs, which change whenever its process is relaunched. When browserd stops a managed browser (after it goes unused for the idle release time, or when its controller restarts), it keeps the browser's tabs in the session directory, as a hash of each page's URL. The next launch on that profile, and the relaunch after a lost browser process or a state capture, matches them to the tabs it reopened, and each reopened tab keeps its earlier ID. A tab is matched only when it is the one tab showing its URL before and after, so tabs that share a URL never take each other's IDs. A controller that reattaches to a running browser after a restart gives its tabs the same IDs. An old tab ID that no reopened tab took over answers that the browser was stopped and relaunched, that this tab was replaced, that its page may be open under a new ID and unsaved page input may be lost, and to list the current tabs. A tab the driver saw close says when, and whether a close-tab call or its page or someone using the browser closed it. Any other unknown ID says to list the current tabs and use one of their IDs. Every message still starts with "browser target does not exist". An action refused before dispatch because its tab is gone now keeps the driver's target_not_found code and explanation instead of a generic driver failure.
- f6298be: Role, text and ref locators now reach a visible custom menu that a web component puts on screen through a shadow-root slot, and on pages of up to about 1,000 accessibility nodes browser outlines show it too. Chromium updates its accessibility tree incrementally and leaves out content assigned to a slot after the slot was laid out, so such a context menu was on screen but missing from the outline and `locator_not_found` for every semantic locator. browserd now rebuilds the tree before a locator reports `locator_not_found` or a wait times out, on larger pages also once when a locator or wait first misses, and on small pages also for outlines, the first read of each action and about once a second while polling. Text that CSS generates keeps its ref across these rebuilds. Text and label locators also take `exact` (whole accessible name, ignoring case and spacing), as role locators do: the browser action schema already showed the field, but the server rejected it on those kinds. Code Mode `getByText` and `getByLabel` take it as their second argument.
- bd8e4b4: A Mac whose screen is locked, or shows another user's session, no longer offers this session's windows as computer targets. macOS keeps listing them in that state, but every read of one came back empty (`ax_window_unresolved`) and input never reached them. `computer_open` now opens the computer with no targets and says plainly why and what a person must do; listing, observing, capturing and acting fail with `machine_locked` and the same reason, and the same computer works again once the screen is unlocked or switched back. The state is read natively by the new `computer-native window console` command from this session's CoreGraphics dictionary, the IORegistry's `IOConsoleLocked` and the owner of `/dev/console`: after a switch to another user, this session's own dictionary can still claim the console.
- a52b5b9: macOS computer readings of slow apps (iOS Simulator windows on a busy Mac) are about three to four times faster and no longer cut off their lower controls, and the first reading after an action shows the screen the action led to rather than the one before it.
- 8df383f: On macOS, observing a window whose app is too busy to answer accessibility (some apps are while they show a menu) no longer fails with a server error after 7 s. CUA now bounds the requests that find the window by the read's time budget, and the observation comes back with the screenshot, marked as cut short because the app answered too slowly, while refs from the last reading keep working (keys are refused on such a reading, since it shows no focused element). A web `<select>` in a WebKit view (apps that embed a WKWebView) now works while its menu is open: `set_value` picks the option by name from the open menu (or opens it, picks and closes it), uses an open menu only when its chosen item lies over that select (never a neighbouring select's menu), and checks the select shows the option afterwards. Invoking one of the menu's items is accepted instead of being refused as outside the window when the menu is open over that window, and pointer or key input to it is refused with a message that names the open menu. The first reading of a WKWebView window no longer omits the web page: an element that times out once is asked again, and in a timed reading one that never answers marks the reading as cut short instead of disappearing.
- f98cbd9: Clicking an option of a native dropdown whose list is open no longer sends the page a stray Escape key release when the list closes; the page sees no key events, as when a person picks an option. Options hidden by an `optgroup` with the `hidden` attribute or by CSS `display: none` are now refused like disabled ones.
- 93ac8fd: Linux computer use accepts more key names: F1 to F24, Insert, PrintScreen, ContextMenu, ScrollLock and Pause, and a modifier pressed on its own, such as Super. A function key the X11 layout lacks (F13 to F24 on most layouts) is bound to a spare keycode for one complete press and restored afterwards. On GNOME Wayland, a named key that no group or level of the keyboard layout has is refused instead of being silently dropped. CapsLock and NumLock stay refused, because a lock left on silently changes later typed text. The first pointer action after observing a native Linux or macOS computer no longer fails as a stale frame when the screen has not changed: the frame of the screenshot an observation returns stays the helper's newest frame.
- 1ed80fb: Every browser and computer tool that names a BrowserSession or ComputerSession now answers a missing id with this chat's open sessions of that kind: browser_open and computer_open when attaching, the browser clipboard, downloads, download save, recording save, publish and lifecycle tools, computer lifecycle, and the native computer tools. Tools that need an id only list the ids to use; open tools also offer to open or reuse one. Session labels are shortened by character, so an emoji is never cut in half. A browser launch that fails no longer discards the record of the tabs its stopped predecessor had, so the retry still says which reopened tab shows each old tab's page.
- Updated dependencies [931325b]
- Updated dependencies [d649005]
- Updated dependencies [5aa883b]
- Updated dependencies [4488c59]
- Updated dependencies [5a48fe7]
- Updated dependencies [3ee89da]
- Updated dependencies [2a181e7]
- Updated dependencies [f6298be]
- Updated dependencies [58d272f]
- Updated dependencies [01188c9]
- Updated dependencies [995c16f]
- Updated dependencies [53e1fe5]
- Updated dependencies [d30a243]
- Updated dependencies [659f5a4]
- Updated dependencies [5b9feb9]
- Updated dependencies [de7087a]
- Updated dependencies [cb15454]
- Updated dependencies [a8b429e]
- Updated dependencies [57cfc37]
- Updated dependencies [f20b8fb]
- Updated dependencies [96502c5]
- Updated dependencies [5f332c1]
- Updated dependencies [24b71c6]
- Updated dependencies [54c2f9e]
- Updated dependencies [936d9e0]
- Updated dependencies [4651b0d]
- Updated dependencies [30b9cd2]
  - @opengeni/contracts@5.4.0
  - @opengeni/interaction@5.4.0

## 0.4.9

### Patch Changes

- c8ddf55: A browser or computer action batch that legitimately runs longer than a minute (for example waiting for an upload, filling a field, pressing Enter and then waiting up to 90 seconds for a reply) now completes and returns its normal receipt instead of failing with "The workspace is temporarily unavailable". Each action request gets a deadline derived from its own declared waits: the sum of each action's longest wait, plus the settle after page input, plus a fixed margin. It is never less than the previous one minute and never more than 20 minutes. Every layer that carries the request honours that deadline: the API's controller request on every transport, the Connected Machine runner (whose cap rises from 15 to 20 minutes) and its reply timer, the socket idle timers of the API-to-controller and tool-to-API requests, and the API and browser controller servers, which no longer apply their idle timeout to a running action. A request that still outlives its deadline (or an older runner's 15-minute cap) is not retried and returns `504 action_timeout`, telling the agent that the action may still be running and to check the page or window before doing anything again. `@opengeni/contracts` exports the shared wait and settle bounds and `browserActionDeadlineMs` / `computerActionDeadlineMs`.
- 4b3f4b7: Closing the last tab of an attached Chrome profile no longer disconnects the profile. Chrome closes a profile with its last window, which stopped the extension and ended the profile's connection while Chrome kept running; the extension now opens a new tab page in that window before closing the profile's only tab. A new tab in a Chrome that is running with no window open (common on macOS) opens in a new unfocused window instead of failing. A tab close whose profile connection ends before the extension answers is reported as `outcome_unknown` (HTTP 409) telling the agent to list the tabs again, instead of an unexpected internal error, and a tab Chrome says is already gone is `target_not_found`. `interaction_discover` now shows the model a compact inventory: each BrowserSession and ComputerSession keeps what is needed to reuse it (id, name, lifecycle, placement, engine or platform, identity, last use, whether it belongs to this chat and the capabilities it lacks), and at most 50 sessions and identities of each kind, this chat's own first and then usable ones by most recent use, with a note naming how many were left out; the whole result stays within a fixed byte budget (768 KiB) and each session keeps only its association with this chat, so it never needs a spill. A large workspace used to produce a result of megabytes that the model could not read. Closing a tab that is already gone no longer makes the agent forget its current browser, and a close whose connection ends before the remaining tabs are listed is `outcome_unknown` too. Code Mode programs still receive every full record.

  A tool result too large for the model (over 1 MiB) is now always readable where the agent runs. Its receipt names the copy's absolute path on the machine it was written to (a Connected Machine's own folder or the sandbox's root), so it opens from any working directory; before the turn's sandbox has started it names the path the copy gets when it starts, instead of none; and a text line after the receipt says to read parts with the shell and, when there is no copy, to fetch the file by its id with `files_get_download_url`.

- ab5fcc1: Attached Chrome no longer loses a tab when another extension puts its own frame in the page, as password managers do for their inline menus. Chrome ends and refuses debugging of a tab that holds another extension's page, so the extension now removes those frames from tabs it controls (including inside closed shadow roots) and attaches again, using the new `scripting` permission with access to all sites; Chrome's permission warnings are unchanged because the debugger permission already covers all sites. When the page keeps adding the frame back, the tab fails with a clear error that names the password manager and says to turn off its inline menu for the site or use a managed browser. Each attachment now has a number, so a late command for an ended attachment is refused instead of reaching its replacement and a detach reported after its replacement attached no longer ends it; input that Chrome ends part way is reported as outcome unknown without making the tab unusable, and the extension accepts `Inspector.enable`, which browserd sends on every attach.
- c0c50f3: A browser action's result now includes the response to a request its page handler started only after awaiting something (reading the chosen file, hashing, a validation promise). After a click, key press, typed text, choice, check, upload or pointer action, the driver gives the page one frame to start such a request and settles it like the others, so the agent no longer has to observe again to see "Imported" or "Submitted".
- f6f112a: Saving a browser recording now works when the browser runs on a machine with a slow link to storage. Previously a save waited for the whole recording to upload inside one request; anything that took longer than a minute failed, and every retry started the upload from scratch.

  The browser host now uploads the recording in the background. A save waits up to 45 seconds and then answers `202` with `retryAfterMs`. Repeating the save with the same `operationId` joins the upload that is already running. The SDK's `saveBrowserRecording` repeats the request until the save completes, or until its signal aborts.

  Staged recording objects are scheduled for deletion on a durable deadline, so a save that is never repeated leaves nothing behind. Controllers that predate background uploads are still waited on in a single request.

- e79e020: A browser whose saved process had exited is relaunched on its profile when it is next used. If that start failed partway (for example because a restored tab had no JavaScript context yet), the browser service detached from the new browser instead of stopping it. The browser kept running with nothing tracking it, and every later attempt to open the session was refused because the profile could not be proven unused. Now a failed relaunch closes the browser it started, so the next attempt relaunches the same profile with its tabs. The start also no longer fails when a restored tab has no JavaScript context yet: the optional viewport reading is skipped, and the user-agent reading uses its hidden page, as it already does when the page returns nothing.
- 48e5c71: Browser `fill` sets sliders: a native range input takes the value directly (a value between its steps is refused with the nearest one it takes), and a custom `role="slider"` element is moved with its arrow keys until it reports the value. Page readings show a slider's or progress bar's numeric value and no longer list empty properties.
- 6e50f56: browser_act and computer_act accept `role:name` as a bare locator string (`"link:Sign in"`, `"push button:Save"`), meaning the element with that role and exact name, next to a bare element ref. In browser_act, `label:` and `placeholder:` name those locator kinds instead. computer_act actions may also leave out `type`: an action with a locator is semantic and one with actions is a batch. Exact names now compare whole names in any case and spacing, the same way in the browser and in computer readings. A repeated form fill needs about a third fewer output tokens per record.
- 8b08c70: Computer readings on Linux and Windows now show whether a checkbox or switch is on (value "1" or "0", as on macOS); before, browserd dropped the state CUA reports, so agents could not see it and set_value true or false on one was refused. Linux switches and toggle buttons now report their state too. The computer_act description says that set_value true or false on a checkbox or switch leaves it in that state and presses it only when needed, so one batch can cover a whole record without reading the checkbox first.
- ee7d19c: On macOS, the buttons and fields of a bubble a window shows (Chrome's "Save password?", translate, site permission and download bubbles) can now be used through that window, instead of every action on them being refused: invoke and set_value on their refs work, while pointer and key input to them is refused with a message saying so, since it would land on the page under the bubble. An element of another window of the app is still refused, and the failure names that window when it is a target that can be observed.
- a573319: Computer-use action batches spend less time on fixed waits. Lookups inside a batch no longer walk every menu of the app's menu bar, a step picks its element from the read its wait just made, batched steps no longer wait for the cursor glide, polls run every 100 ms, and text-field writes poll their read-back instead of sleeping. Setting a dropdown to the value it already shows no longer empties it.
- 7023400: computer_act batches on a computer that runs them as one operation no longer read two recorded receipts before every batch (each one a 404 on a first try); a retry is answered by the computer's journal, or by its recorded receipt when the journal refuses the retry's new fence or the window is gone. CUA batch steps named by role and name now find their element again when the page re-renders just before the press, and several matches of the named role wait for the window to settle before they are reported (without searching other windows), so a list a search is still filtering narrows to the one meant; a later action of a batch whose name its observation shows on several elements now reaches that wait instead of failing at once. computer_act's description mentions looping over many records in one Code Mode program once one has worked.
- 68bcc7a: Computer use: `set_value` true or false (or on, off, checked, 1, 0), `select` and `deselect` on a checkbox or switch press it only when it reads the other state, so a form with checkboxes fills in one batch. A checkbox acted on after another action of a batch is read as its step runs (CUA fork `toggle_to`, pinned at 11b06dbb4), never from the observation taken before the batch, and a press that does not take is reported either way. A mixed (indeterminate) checkbox counts as neither state, and a later batch step may select or deselect a checkbox or switch the batch does not show yet.
- c84e6ed: On macOS, the first computer-use reading of a Chrome window now includes the page. Chrome accepts the driver's accessibility switch but reports an error, so the driver used to skip waiting for the page and kept re-sending the switch, which stopped Chrome from ever building the page tree while reads came quickly. A dropdown menu that is really open is also closed at once instead of after a wait Chrome ignores.
- cccd692: Computer tools that omit targetId now keep working in the window the computer was last observed or acted on in, also in a later turn. The remembered window lived for one turn attempt, so the first such call of a follow-up turn ("do the rest") failed with computer_target_required and the agent had to resend both identifiers. A computer's target list now marks that window with `current: true`, and a call that omits targetId before its attempt used a window of the computer uses it. A window this attempt used still wins, and when the computer has no current window the call still asks for targetId.
- 7ccc761: computer_observe without a targetId on a computer the agent has not used yet starts in its focused window, or its only screen when no window is focused, instead of failing. Actions still need a window the agent has seen or named.

  On macOS and isolated Linux desktops, the frontmost ordinary window (highest stacking order, menus, overlays and minimized windows aside) is now marked focused in computer target lists. Windows desktops mark none yet, because their window listing stacks cloaked and always-on-top windows as ordinary ones.

- 070b4f8: A desktop observation names its window by the title its reading shows, not the title the window had when the windows were last listed, so after an action opens another page the receipt's window line names that page instead of the one before.
- 4f98128: On macOS and Linux computer use, refs now carry over between two readings of the same page after an action opened it. Whether two readings show the same document was judged by the window's listed title, which still names the previous page until the windows are listed again, so the reading after a navigation and the next one compared unlike and every ref of the new page changed: an action naming a ref from the action's own receipt failed as stale although the element had not changed. Readings now compare the title of the window element they carry themselves, and fall back to the listed title when they carry none. A window that shows another document still keeps none of its refs.
- cef4c08: On macOS and Linux computer use, the window reading an action returns now waits while the action has started work the page shows in progress: for up to 5 seconds while a busy element or spinner shows, and for up to 2.5 seconds while a short text ending in an ellipsis, such as "Saving..." or "Loading…", shows on a text, label, status or disabled control that the window did not show before the action. This includes a disabled "Saving..." button that Chrome on macOS shows only within the page's description. The agent then sees the result of a save or load in the action's own receipt instead of observing again. Menu items such as "Move to…", typed field values, a control that only turns disabled, and longer texts cut short with "…" do not count, so such an action reads the window once, as before. The readings taken while waiting do not replace the ones the agent planned from, so their refs still act.
- a59ecc1: A macOS table no longer reads as three tables. macOS lists every cell again under each AXColumn, as new elements with the same role, label and bounds. A computer reading now lists such an element once, and a step that names it by role and name finds one element instead of an ambiguous pair. This holds in browserd's own lookup and in CUA's (fork pin 7e98e221e). Same-named elements at different places still count as separate elements.
- b171834: Desktop computer use: set_value on a web date or time field in a browser that is not the active app now fills it, by focusing each of its parts through accessibility before typing it. Before, pressing the field focused no part in the background, so every key was dropped. A field's "Show date picker" button now points to the field instead of opening a menu that would bring the browser in front, and a refused web dropdown menu says to choose its option with set_value instead of naming an input mode the tool does not offer.
- 17cb8b9: Computer batch actions that name an element by role and exact name now ignore runs of whitespace in the name, as the first action of a batch already does.
- 5adf6e5: A computer's first reading no longer picks a small untitled window stacked above an app's window, such as Chrome's link status bubble or an emulator's side toolbar, as the window in front.
- dca33ef: On macOS a computer-use batch step that names a button or link by name, when the control has the other of those two roles, now presses or checks the one element of that name once the window's complete reading has settled, and says which element it used, instead of waiting out its timeout and failing. Toggles never stand in, several such elements fail as ambiguous, and a window that never settles fails as before. A computer action receipt lists such actions in its optional `roleStandIns`.
- 7c02dbd: Windows computer use can type into and click the app it just opened. Before input, the Windows backend brings the target window to the front itself: it dismisses Start or Search if one of them holds the foreground, restores a minimized window, activates it while attached to the foreground thread, and as a last resort clicks the window's own title bar. Only when all of that fails does it refuse, naming the window that kept the front, and none of the action's input is sent. After keyboard input the foreground goes back to the window that had it, as CUA itself does. After a click the clicked window deliberately stays in front, unlike CUA, so a menu or popup the click opened is not closed. Nothing is given back to a dismissed Start or Search, the desktop or the taskbar. A Windows "window was not in front" error from CUA is reported as retryable with nothing sent only when CUA says no input was sent; after a click CUA already sent, it is an unknown outcome to check before acting again.

  The Windows CUA tool catalog is regenerated from the bundled CUA 0.37 driver, so the native `cua_*` tools no longer fail with "CUA tool schema differs from this release". Each generated catalog now records the CUA version it came from, and a test fails unless every catalog names the `@trycua/cua-driver` version browserd pins.

  `computer_open` accepts `includeScreenshot`, like `browser_open`: the result then also carries a still image of the screen with its frame id and pixel size. With several screens it captures the one the computer works in, else the focused one or the one showing the focused window, and it returns no image when the screen changed while it was captured.

  A rejected computer session request body now names the first rejected field, for example `invalid request body: expectedFrameId: pointer action frameId must match expectedFrameId`.

- Updated dependencies [c8ddf55]
- Updated dependencies [1988e97]
- Updated dependencies [e7f5d38]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
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
- Updated dependencies [392db50]
- Updated dependencies [31bca3c]
- Updated dependencies [6acfbd3]
- Updated dependencies [21e7ecf]
- Updated dependencies [627b2f1]
- Updated dependencies [c307566]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [f9f0607]
- Updated dependencies [cc319f3]
- Updated dependencies [3b1d8c1]
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
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0
  - @opengeni/interaction@5.3.0

## 0.4.8

### Patch Changes

- 2752a36: On macOS a web page's number field (`<input type=number>`) now shows as a `spinbutton` that offers `set_value`, instead of a raw `AXIncrementor` offering only invoke and a focus that failed. Its value is written as text and checked afterwards: a field that reads its old value or nothing instead of the number it was given fails the action, and CUA puts back the old value of a field a value emptied and refuses the write, so `set_value` (also as a later batch step that names the field) never silently clears it. `focus` on it works. A web range input given a value is stepped to it; a value outside its range is refused without moving it, a run that stops short fails saying what it reads now, and a slider that reads anything but the value it was given fails the action. A value write CUA refused and put back is reported as a definite failure rather than an unknown outcome. The parts of a date or time field stay as they were, and a web date field that already had a value now reads the date typed into it (Chrome keeps the field's own value at the first one), so filling it no longer reports a failure (parts that form no calendar date, such as 31 February, do not count).
- a800c15: On macOS a `set_value` that CUA refuses because the value is outside a control's range, or because stepping stopped short of it, no longer repeats the value in its message, since it may be a secret such as a PIN in a number field.
- Updated dependencies [fb72b9d]
  - @opengeni/contracts@5.2.0
  - @opengeni/interaction@5.2.0

## 0.4.7

### Patch Changes

- 442354f: A `computer_act` batch on macOS and in Linux sandboxes can now cross a page or form change. A later action whose role, label or text locator names an element the batch's observation does not show yet is sent to CUA by role and name; CUA finds it when that step runs, after waiting up to 10 seconds for it to appear and enable. Element-targeted actions after it are found by name too (an exact name for a ref), since CUA's lookup retires the observation's tokens. CUA is pinned to a revision whose lookups and checks accept `exact`. The tool description tells agents to do each record of a repeated procedure in one batch.
  - @opengeni/contracts@5.1.0
  - @opengeni/interaction@5.1.0

## 0.4.6

### Patch Changes

- Updated dependencies [487bd43]
- Updated dependencies [a9d20b3]
- Updated dependencies [6d29c01]
- Updated dependencies [217ed52]
  - @opengeni/contracts@5.0.0
  - @opengeni/interaction@5.0.0

## 0.4.5

### Patch Changes

- 3e378e5: A tab in the person's own Chrome that reports no address yet (one Chrome just opened or is still loading) or a very long one (a large `data:` page) no longer fails listing the browser's tabs or starting a session there.
- 104a12e: Cleaning up after a crashed controller no longer abandons a tab it opened that Chrome still lists without an address: the tab stays recorded and a later sweep closes it once it shows it is empty.
- Updated dependencies [85fb89e]
  - @opengeni/contracts@4.8.0
  - @opengeni/interaction@4.8.0

## 0.4.4

### Patch Changes

- d9fb31c: An agent using a person's own Chrome no longer leaves empty tabs behind or keeps Chrome's "started debugging this browser" banner up. Whatever ends a session's controller runtime (an end, an agent restart or update, or now also ten minutes without use) closes the tabs that session opened that are still blank and releases Chrome's debugger. Tabs the session did not open, tabs showing a page, and tabs another session is using stay. The session's next request continues in the tab it was using instead of opening another blank one, and a controller that starts after one crashed cleans up what it left. A debugger released by another controller is attached again on the next use instead of leaving the tab unusable. A session waiting on a JavaScript dialog keeps its browser (managed or the person's Chrome) through idle release and agent restarts until the dialog is answered (for at most 30 minutes), because a debugger attached later can neither see nor answer it; a continuing session waits at most a few seconds for its earlier tab, and a read that meets a dialog whose event has not arrived yet reports the dialog instead of hanging.
- da761bd: The browser click guard no longer refuses legitimate clicks when the page re-renders the target as the pointer arrives (an identical copy now takes the click), and a double-click judges only its first press, so a "double-click to edit" row that turns into a text field on the first click still gets its double-click. On attached Chrome the guard's per-press reports are taken in before deciding a click whose document went away, so a click that reached its target is no longer reported as an unknown outcome. Each guarded click also waits on two fewer CDP round trips.
- 8e57406: A browser click no longer lands on a different element while reporting success on the one it was asked to click. Hit-testing happens before the pointer moves, and a page can put something over the target in between: an open popover that follows its anchor back after the driver scrolled the panel to uncover the target, or a hover card that the pointer's arrival opens. The driver now waits for scroll-driven layout to settle before trusting a reveal scroll. Each click also runs behind a guard in an isolated world: a press that would reach anything other than the target is cancelled together with its release and clicks, and the action fails with the existing "browser element is covered by …" error, which becomes an unknown outcome once pointer input has been sent. Releases and clicks are not judged by their own target, so pointer capture and label-forwarded clicks keep working. A guard that a JavaScript dialog interrupted is removed by the next action once the dialog is handled, and it disarms itself after five seconds regardless. The guard also reports each press's verdict out of the page as it happens, through a binding only its isolated world can call, so a verdict survives the document being replaced or removed before it is read back; a click whose verdict is missing is reported as an unknown outcome rather than a success.
- 5f091b6: Computer use on macOS fills web form fields more reliably. `set_value` on a text field with a value that reads as a number (a card's CVC, a postcode) now writes it as text, and a number a web number or range input took without showing is written again as text: Chrome used to accept the number and leave the field empty while the action reported success. A text field that still reads its old value after `set_value` (read again 150 ms later before judging) now fails with "the app did not take the value; invoke the field and type the text instead". A web date field Chrome leaves without a value of its own now reads the value its day, month and year parts show, so a correctly filled date is no longer reported as "reads empty". When every action of a batch ran but a field check failed, the error says "All N actions of the batch ran, but …" instead of reporting later actions as not run.
- a6a1dac: Once an agent uses the native `cua_*` computer tools in a session, `computer_act` and `computer_observe` stop reading elements themselves so the native element tokens stay valid. Their results used to say "The accessibility tree has no readable elements; use the screenshot", which sent agents to pixel clicks on windows full of controls. They now say the session reads elements with `interaction__cua_get_window_state` and to call it, and two such readings are no longer reported as "no element changed". Semantic snapshots carry this as `readByNativeTools: true`.
- 83c7a88: macOS computer use: `set_value` on a native slider, stepper or checkbox in a document window no longer sends the app stray Space and Delete keys. Only a text write marks a document as edited.
- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
  - @opengeni/contracts@4.7.2
  - @opengeni/interaction@4.7.2

## 0.4.3

### Patch Changes

- @opengeni/contracts@4.7.1
- @opengeni/interaction@4.7.1

## 0.4.2

### Patch Changes

- 7286bf5: An attached Chrome session that is open but unused no longer polls the browser extension twenty times a second. After two quiet seconds it polls once a second, polling stays fast while a command is running, and the next command switches it straight back to fast polling, so actions and the events they cause are not delayed. A machine with many open attached sessions no longer keeps the person's browser and the agent busy with constant event reads.
- 8aa6bd1: On macOS, clicking a text field through computer use now reports that it worked when the field takes the keyboard focus. It used to say the click was not confirmed, which sent agents back to re-read the window before typing into every field.
- 7d03631: On macOS, computer use can now fill a web page's date, time, month, week and date-time fields with one `set_value` in ISO form (for example `2027-03-07` or `2027-03-07T14:05`). The field's parts are typed one by one in the page's own order and the field is checked afterwards. Acting on a single part now points to the field and the form it takes, instead of saying the part cannot take the keyboard focus. Batches whose actions add up to more than 64 steps now run in several calls.
- Updated dependencies [31095f1]
  - @opengeni/contracts@4.7.0
  - @opengeni/interaction@4.7.0

## 0.4.1

### Patch Changes

- @opengeni/contracts@4.6.0
- @opengeni/interaction@4.6.0

## 0.4.0

### Minor Changes

- 6c7b552: Downloads now work in attached Chrome. A file that a tab Opengeni controls downloads appears in `browser_downloads` like a managed browser's download, and `browser_download_save` saves it into the session's workspace. Chrome still saves it in the person's own downloads folder, where it stays untouched; the session keeps a verified copy. The extension asks for Chrome's `downloads` permission so it can tell where Chrome saved a controlled tab's download (it looks up only completed downloads of that address since the download began). With an older extension, such a download is listed as failed with `download_location_unavailable`.

### Patch Changes

- e142b9e: The browser extension now reconnects to the local agent after Chrome stops and later restarts its service worker. A periodic wake-up alarm (new `alarms` permission) reopens the native connection when it is down, so an attached Chrome no longer stays disconnected until a tab event happens. Browser and computer controllers also log the class, frame and redacted message of any dispatch error the driver did not classify, so `controller_lost` failures leave a cause in the agent log.
- ca53d0d: Typing with `mode: "keys"` waits a frame between characters, so split one-time-code boxes that move focus in an effect receive every character instead of only the first.
- 92e227c: An agent update no longer interrupts a browser or computer task between steps. The update used to wait only for the request in flight, so an update that arrived while the agent was thinking about its next step restarted the controller under it, and the agent's next calls failed (draining, upstream unavailable, outcome unknown) until the restart finished. A browser or computer session used in the last three minutes now holds the update back (`browser_recent_use`, `computer_recent_use`); it proceeds once the session has been idle that long or has ended.
- Updated dependencies [f838cb7]
- Updated dependencies [e142b9e]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
  - @opengeni/contracts@4.5.0
  - @opengeni/interaction@4.5.0

## 0.3.1

### Patch Changes

- d948555: Browser actions with a role, label, text, placeholder, test id or CSS locator now wait up to 10 seconds for their element to appear, and input actions wait while the element is disabled. One browser_act batch can therefore open a record, wait for its form and save it across page changes. browser_act's description tells agents to do a repeated procedure's later records as one batch each, or as a Code Mode loop.
- c06640b: Browser clicks now reach buttons built as web components, where the real button sits in a shadow root and its label is slotted in from the page (common in design systems such as Microsoft's admin portals). Before, the click check saw the component's outer element at the button's centre and refused with "browser element is covered by …", even though nothing covered it. The check now follows the same tree that pointer events travel, so slotted labels and shadow content count as part of their button, while a real layer over such a button is still refused and named.
- 7ceffd2: Browsers left running when the agent restarts or updates no longer run forever. A controller that shuts down now stops browsers already unused for the idle release time instead of handing them off, and records each browser it does hand off. Its successor stops a handed-off browser once it has gone unused for the idle release time, asking Chrome to close first so its tabs come back on the next use. At startup the agent starts the controller of any scope that has such browsers waiting, so they are stopped even if no chat uses a browser there again.
- 5c113c6: Managed browsers are now started by the browser controller itself instead of through the separate agent-browser daemon, so the controller is the browser's only DevTools client. This removes launch settings that set managed browsers apart from an ordinary Chrome (hidden scrollbars in headless mode and disabled popup blocking), a second DevTools client attached to every page, one extra process per browser with its launch overhead, and the agent-browser companion from sandbox images and agent installs. It also fixes problems the daemon had been hiding: dedicated web workers on headless pages stayed paused and never ran, a click that opened a JavaScript dialog from an upload control was reported as a completed upload, a network-idle wait could hang on unfinished requests of the page that was replaced, and a full-page overlay was mistaken for a sticky bar when the page showed scrollbars.
- 667778f: A browser still recording, or still running a request, when the agent restarts or updates is no longer stopped by the new controller as soon as it starts. Its idle release time now counts from the shutdown, as it would have on the old controller.
- 62b21de: An idle managed browser is no longer stopped while it is still receiving a download. Before, a download that ran longer than the idle time without any request to the browser failed with `browser_ended` when the browser was released; the browser now waits until the download settles.
- 9929a12: Managed browsers that nobody used for 10 minutes now stop. The profile, tabs and downloads stay on disk with the same recoverable receipt a controller shutdown leaves, and the browser's next request relaunches it on that profile with its tabs restored. Machines that host many agents' browsers, such as connected machines, no longer keep every idle browser running indefinitely. Set `idleReleaseMs` (0 disables) to change the time.
- 8f3a2ba: When managed Chrome exits during launch, the error now reliably quotes Chrome's own stderr (for example `Missing X server or $DISPLAY`). Before, the error often read the stderr log before the drain had written it and reported only the exit code.
- c45db0a: The browser controller starts faster on a fresh sandbox: it now checks the pinned Lightpanda binary when a Lightpanda session first needs it, instead of reading and hashing the whole file on every start. On a fresh VM's cold disk that read took about a second before the first browser could open.
- f1f5e0c: Managed and attached browser tabs no longer keep the CDP Runtime domain enabled. Pages can detect an enabled Runtime domain (the most common automation tell), so console messages and uncaught page errors are now read on demand when diagnostics are requested: browserd briefly enables Runtime, takes the messages Chrome buffered for the current document, and disables it again. Observations count console and page errors that a diagnostics read has reported.
- da6878d: Lightpanda tabs report console messages and page errors again. Lightpanda does not replay earlier messages when Runtime is enabled, so its tabs keep Runtime enabled and record them as they happen; Chrome tabs still read them only when diagnostics are requested.
- 7fd2e82: Computer use on macOS names Chrome tabs without the live memory figure Chrome adds to their accessible names ("Inbox - Memory usage - 85.2 MB" reads "Inbox"). The figure changed on every reading, so action receipts listed every tab as changed and tab refs did not stay stable.
- b12f0ce: Computer use can work macOS file dialogs in the background. A sidebar place, folder or file in an open or save panel offers `invoke`, which opens it the way a double-click does (into the folder, or choosing the file), and no longer offers `set_value`. macOS reports such an open as not completed even when it worked, so the window is read again and the action succeeds when it changed. Keys refused because a sheet or another window has the keyboard focus now say what to do instead, in batches too, and count as an invalid action rather than a driver failure.
- 11e56da: The computer targets note and the off-screen error now say what off screen means on macOS since minimized and hidden windows became readable: a window on another Space, such as a full-screen app. The note no longer points a browser from browser_open to linkedComputerSessionId, because its page windows are no longer listed.
- 340d101: A macOS button press or item open that macOS answers with "cannot complete" (-25205) is checked against the windows afterwards: a changed window, or the one window the app opened when the press closed its own, completes the action with that reading. An unchanged window stays outcome_unknown, and a window that closed says so instead of claiming that nothing changed.
- d3cd58b: macOS computer use is faster: the desktop driver's short waits now wake on time on a busy Mac (they could run up to 150 ms late), and a batch of clicks in one window prepares that window once instead of before every click. A 10-click Calculator batch went from about 6.2 s to 3.5 s.
- a9ebd2e: Computer sessions on a Mac or Windows desktop now share one CUA worker instead of displacing each other. Two agents using the same machine used to restart the worker on every call, which threw away each other's observations and refs and failed actions with stale-target errors; now each keeps its own state and their calls take turns on the shared worker.
- e4a4672: A browser action whose locator is waiting for its element no longer follows the page to a new document unless it is a later step of a batch without fenceEachAction. A fenced batch, a single action or a batch's first action now stops with document_stale before sending input when the page navigates during the wait, instead of typing into or clicking on a page the caller never observed.
- 7d80179: A network idle wait on a page that has finished loading but keeps a long poll or other request open now completes when its time runs out instead of failing, so a navigate with `waitUntil: "network_idle"` on such a page no longer reports an uncertain outcome.
- Updated dependencies [e697879]
- Updated dependencies [11e56da]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [81a516c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [84b1a18]
  - @opengeni/contracts@4.4.0
  - @opengeni/interaction@4.4.0

## 0.3.0

### Minor Changes

- 49f2177: Agents can record a browser flow as a video. The new `browser_record` tool starts a recording of a managed or attached browser tab and stops it into an MP4 in the chat's workspace, with a log of when each action happened beside it, and publishes the MP4 so it plays in the chat. Frames are captured only when the page changes, so recording costs almost nothing while a page is still, and the video is encoded on the server, so browser hosts need no video encoder. The SDK adds `startBrowserRecording`, `getBrowserRecording` and `saveBrowserRecording`.

### Patch Changes

- 0d50963: A browser session in the user's own Chrome now recovers by itself when its event stream from the extension breaks, for example when a burst of page activity overflows the extension's event history, a poll times out or the local bridge connection drops. Before, every later call in that session failed as temporarily unavailable until a new session was opened. The stream is re-established and its tabs re-attach with fresh page state on their next use. A tab that had input in flight at that moment stays refused, as when Chrome detaches it, and a profile that reconnected to Opengeni now gets a clear, final instruction to open a new browser session.
- d25fb3e: Downloading a file with the same name as an earlier download in a managed browser no longer loses the earlier one. Chrome saves both under the same name, so the later file used to replace the earlier one, which then could not be read or saved. Each completed download now keeps its own bytes, and the Downloads folder still shows the files under their real names.
- 4aeaf11: Uploading a file through a button inside a cross-origin iframe now works. Before, the browser looked for the frame and its file chooser in the main page, which cannot see frames another site renders, so the upload failed with "upload control frame is unavailable". Upload dialogs embedded from another site, such as an office suite's add-in upload dialog, are common.
- ed3a64c: On computers whose CUA driver supports it (macOS and Linux), a computer_act batch of semantic and keyboard actions now runs as one CUA operation checked against one observation, instead of one operation per action, which roughly halves the time of a long batch. Whether a computer session runs batches this way is fixed for the session's life, so every try of one batch, including tries on either side of an agent update, runs it the same way and never repeats its actions. CUA Driver is updated to 0.37.
- 659c01a: Computer targets now mark a macOS window that is off screen (minimized, hidden, or on another Space or display), which can be neither captured nor read, so an agent sees it in the listing instead of finding out from a failed read. When any listed window is off screen, the listing adds one fixed note that a browser from browser_open runs off screen and can be shown on the computer by opening it with linkedComputerSessionId.
- f183dfd: On macOS, computer targets no longer list windows a person never sees: a headless browser's page windows (including the browser from browser_open), and windows an app keeps ordered out such as closed popovers. A minimized window or a window of a hidden app is listed as readable, and reading it first brings it back on screen behind the person's front window, without activating its app or taking focus. Only a window on another Space, such as a full-screen app, stays marked off screen.
- 46a2ef3: A computer or browser driver failure (`driver_failed`) now tells operators what failed. The controller sends the failing error class and function beside the unchanged error, and server logs record them with the driver message's code-written part, with window titles, page text, paths and free-text reasons redacted. The controller's own log line for a failed request is redacted the same way and now also covers known driver failures. What callers and agents are shown does not change.
- b20c9b2: Retain bounded agent-update blocker categories/counts and show their report age
  and elapsed holds in Machines and fleet, without disclosing private session IDs. Distinguish controller work
  from native request admission without changing update safety, killing work or
  adding command deadlines. Older agents that cannot identify a blocker remain
  explicitly unspecified. These diagnostics do not establish the cause of an earlier
  hold whose admission snapshot was not retained.
- 16258f2: Idle managed browsers on a Linux desktop no longer burn CPU. A windowed managed browser held focus emulation on every tab, which keeps a page rendering as if it were being captured, and Linux has no window occlusion tracking, so every animated page in every idle browser kept drawing frames through software GL: on one shared desktop, 33 mostly idle browsers used about 10 CPU cores.

  After a minute without any use and with no live view open, the controller now parks the browser: it switches focus emulation off and minimizes the browser's windows, so its pages become hidden and stop drawing (timers, network activity and screenshots keep working). The next observe, action, tab operation, screenshot or live view presents the browser again before it runs, so agents and people always act on a normally rendering page. A browser linked to a ComputerSession keeps its window, and macOS, Windows and offscreen browsers are unchanged. In a measured case, an animated page dropped from about 3 CPU cores to 0.02 while parked.

- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
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
- Updated dependencies [23fed2a]
- Updated dependencies [e4915c1]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [724b529]
- Updated dependencies [3915617]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [b95784c]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/contracts@4.3.0
  - @opengeni/interaction@4.3.0

## 0.2.26

### Patch Changes

- 30b3225: In the user's own Chrome, a click that submits a form or follows a link now returns the page it led to, as in managed browsers, instead of the page it left. Debugger events reach browserd by polling there, so an action now waits until the events Chrome sent before its last reply have been seen before deciding whether a navigation is pending.
- 7dcb1d5: Making room on a full browser controller is now safer. A browser is saved to make room only if it is still idle, active on the same controller and free of other operations at the moment it is claimed, and a browser another request already saved no longer counts as room made. A failure while preparing the save returns the browser to active instead of leaving it stuck suspending. Downloads kept when any browser is saved stay private to the owner of a private chat instead of becoming workspace files, even when another person's request made the room, and are read back as that owner once the request is authorized for the chat. Keeping downloads no longer risks the save expiring before capture. The memory-based browser limit now honours memory limits on the controller's own nested cgroup and its ancestors, wherever the cgroup hierarchy is mounted.
- 0544414: Ending a managed browser no longer takes about 30 seconds when a tab closed while the browser was still setting it up, for example a new tab whose server never answered. The browser is now asked to shut down over the controller's own connection, which that unfinished setup cannot hold up.
- e189078: A JavaScript dialog (alert, confirm, prompt) that a browser action opens no longer leaves the call hanging or silent. The action returns at once with the dialog's type and text, even when no page view was requested; a batch stops at the dialog and says how many of its actions ran; and page reads, fenced batch steps and screenshots that the dialog blocks end immediately with the same guidance to answer it with `handle_dialog`, instead of waiting out their timeouts. This holds in managed browsers and in the user's own Chrome.
- 49b121d: Browser observations now show what form fields contain (text inputs, text areas, search boxes, number fields), as the page shows them on screen, so an agent can read a draft or a prefilled form and check what it typed without a screenshot or an extra read. Password fields stay redacted. Every secret value a browser or computer session typed from a secret reference is now remembered for that session and redacted from all its later observations, page reads, dialogs, clipboard reads and window titles, not only from the result of the action that typed it. Field values longer than 2,000 characters are clipped in the page outline with their full length noted; `browser_read` with `mode: "dom"` returns more.
- c27cffc: Make bulk browser work easy to script with Opengeni's own browsers. `navigate` takes an optional `waitUntil` (`load` or `network_idle`), and `viewport` defaults to desktop layout when `mobile` is omitted. `tab.navigate(url, { waitUntil })` passes it through in Code Mode. An explicit `load` wait now waits for the page's load event (images and other subresources finished), not just a parsed document. `ogtool call` and the native `codemode call` now write image blocks such as screenshots to files and print their paths instead of base64 pixels, and `--save-image <path>` saves the single image at an exact path. An existing `--save-image` path is refused before the call; a completed call whose image cannot be saved still prints its result with `imageSaveError` and exits with status 4. Expired temporary image directories are removed only when private and owned by the same user.
- 8a0b07a: Computer use on macOS, Windows and Linux: an action that names an element by a ref from an earlier observation of the same window now acts on that element instead of failing with "locator must resolve to exactly one observed element" (an action without fences is checked against a fresh observation, which mints new refs). A ref that is in no recent observation says so and names the current observation. When CUA refuses or cannot confirm an action, the failure now carries CUA's own reason and hint instead of only "refused the operation". On macOS, `super`, `command`, `win` and `opt` are accepted as modifier names. On macOS, computer_act's `launch` action now starts an app by bundle id or name in the background without taking focus (it was reported as unavailable, so agents had to use the shell); its windows then appear as targets.
- f5b1b40: Computer sessions on Windows and Linux can now launch apps, as on macOS, in the background without taking focus. On Windows an app is named by its display name, its packaged-app ID (AUMID) or the full path of its executable. On Linux it is named by its command or installed application name.
- 73b4253: macOS computer-use key combinations (such as cmd+s) go through CUA's hotkey, so a menu shortcut sent to a background app runs its menu item instead of being silently dropped; a refusal because macOS disables the item in the background is reported as unsupported.
- ecea8b9: Computer use on Windows now returns the window's accessibility tree. The Windows adapter did not ask CUA for structured elements, which CUA only returns on request, and CUA's one-second default walk budget timed out before Windows UI Automation answered even simple windows such as Notepad or the Run dialog. Observations therefore always said "no readable elements". The adapter now requests elements on every platform and gives Windows a five-second walk budget.
- 5252d01: Embedding products can show their own name everywhere people look.

  - `@opengeni/react`: a `productName` prop on `OpenGeniProvider` and `OpenGeniMessagesProvider` (and `createOpenGeniText`) fills `{product}` in every built-in string that names the product, such as credit labels and recovery notices. Default "Opengeni".
  - `@opengeni/agent-host`: `browserExtension: false` keeps an app's own agent from registering as the Opengeni Browser extension's native host, and removes a registration it made earlier, so another agent on the same computer keeps the extension.
  - The agent's browser and computer helpers now run as `browserd` and `computer-native`, so Activity Monitor and Task Manager show no product name under an app that runs the agent under its own name. Older names beside an installed agent are still found.

- b8d5b64: A machine's browser limit now follows its memory instead of a flat 64: half of the machine's memory (or its container's limit) at 300 MiB per browser, never under 8, so a 48 GiB machine runs 81 browsers and an 86 GiB one 147. `OPENGENI_BROWSERD_MAX_SESSIONS` still overrides it. When a new browser would exceed the limit, the least recently used browser that has been idle for at least five minutes is saved and stopped to make room; it resumes from its saved working copy the next time it is opened. Nothing changes below the limit.
- Updated dependencies [641e179]
- Updated dependencies [e018445]
- Updated dependencies [5715a3e]
- Updated dependencies [47eeb80]
  - @opengeni/contracts@4.2.0
  - @opengeni/interaction@4.2.0

## 0.2.25

### Patch Changes

- 5a641af: File uploads now work in a person's own Chrome. Before, every upload there failed with "this browser placement cannot resolve workspace files for upload". Chrome lets an extension select local files directly only when "Allow access to file URLs" is on for it; when it is off, the files are now placed on the file input from the page instead, up to 32 MB per upload, with the same input and change events. Larger uploads fail with a message that names the setting.

  Chrome's own refusals of a command on an attached tab are now reported as ordinary protocol errors with their real message, and a refused command no longer leaves the tab marked as possibly mid-input, which used to block reconnecting to it.

  - @opengeni/contracts@4.1.2
  - @opengeni/interaction@4.1.2

## 0.2.24

### Patch Changes

- dd3df04: A browser action that starts a page navigation, such as submitting a sign-in form or following a link, now returns the page it led to. Before, a form post often returned the page it left, so the agent had to observe again. The wait is bounded, and a navigation that produces no new document (a 204 answer or a download) ends the wait as soon as the frame stops loading.
- 07c53d0: Localhost servers listening only on ::1 (for example a default Vite dev server on many Linux distributions) stay reachable in managed browsers on Linux machines. The private browser network namespace now keeps IPv6 loopback and is used only when the pasta found forwards each host loopback listener on its own address family; otherwise the browser launches on the machine's network as before, with the existing one-line notice. Chrome also waits for the namespace's IPv6 addresses to settle, so a late kernel address announcement no longer drops its first connections.
- afff3f9: Managed browsers on Linux machines no longer fail requests with ERR_NETWORK_CHANGED when containers, bridges or VPN interfaces come and go on the machine. Each managed Chromium now runs in its own network namespace bridged to the host by pasta, keeping the person's UID, host localhost servers, DNS and the DevTools endpoint working. Machines without pasta or user namespaces launch as before, and browser_open then adds one plain line saying page loads can fail when the machine's network changes.
- a17411f: Relaunch a recovered managed browser through the normal browser launcher instead of its recorded process image. On hosts where Chromium is installed behind a wrapper (NixOS, Debian, Google Chrome's own launcher script), the bare image skipped the wrapper's sandbox setup and aborted at startup, so a browser whose controller and Chrome had both gone away could never be opened again.
- 58b9e0f: A computer helper that crashed is now replaced on the next read instead of failing every later read with an internal error. A helper that cannot be shut down now fails with a clear controller-lost reason, and a helper that cannot restart reports a retryable unavailable error.
- ce99e23: Open headed managed browsers offscreen on Linux hosts without a graphical display. A server or an agent running outside the desktop session has no display, so windowed Chrome exited before DevTools started and every default browser_open failed until the agent retried with headless=true. These hosts now run the same real browser and profile offscreen with an ordinary desktop User-Agent and screen, as on macOS.
- 938050b: Lost browsers recover in more cases and refuse clearly otherwise. A browser whose controller died is relaunched in its own directory even when the agent-browser daemon that launched it is still running: that daemon is identified from its own environment and stopped. macOS controllers now prove that nothing runs a profile from one full process listing, so lost browsers there resume like on Linux. Daemons whose browser is gone are stopped when a session ends and when a controller starts, instead of running forever. A recovery proof that cannot be completed is a 409 with its reason instead of an internal error, and a lost browser's preserved working copy can be inspected and adopted through the controller generation that owns it.
- Updated dependencies [afff3f9]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/contracts@4.1.0
  - @opengeni/interaction@4.1.0

## 0.2.23

### Patch Changes

- 9c0c567: A failed browser action now returns the page as it is after the failure, the same outline a successful action returns, so the agent can act on current elements (for example the fresh ref of a control that re-rendered) without a separate observation. Fill on something that is not a text field (a native select, a custom combobox, a checkbox) is refused before any input with the action that works on it, instead of typing into it and reporting an unknown outcome. Observations now show the chosen option of a non-editable combobox, such as a native select; typed text in editable fields stays hidden.
- 26b4c24: Lead the compact browser outline with what needs attention on dense pages. An opened menu, dialog, listbox or tooltip, live messages such as toasts, and the focused or acted-on element with its small enclosing group now come first, the page's own content next, and site navigation last; empty live regions are left out. The omitted-element note names the largest regions it left out. A role or text locator that matches several elements now picks the single one whose whole name is the requested text, and an ambiguous locator lists its candidates with refs. A covered target names the element on top of it, and a failed step in a batch says which step failed.
- a819a58: A browser that cannot start now says why. A machine without Chrome or Chromium reports that plainly as an unsupported placement, other launch failures carry the driver's own reason, and `browser_open` returns that reason as an error instead of a bare failed session.
- 9e407fd: Opening or navigating to a page whose server never answers now fails after 20 seconds with "browser could not load the requested URL: its server did not respond within 20 seconds", and the tab stops loading. Before, the request waited for the generic browser command deadline, so a browser open failed with an unspecific controller error and the result was reported as unknown. A page that cannot load now names Chromium's reason, for example net::ERR_CONNECTION_REFUSED, and a tab opened for an unanswered page is closed instead of left behind.
- 4d576d0: A managed browser relaunched on its existing profile now gets its tabs back after the previous browser was killed, lost with its host, or copied while running (working-copy adoption). Chromium skips `--restore-last-session` when the profile's last run did not exit cleanly, so these relaunches opened a single blank tab. The supervisor now records that last run as a normal exit before such a relaunch, and Chromium restores the last session.
- c696c3f: A browser screenshot taken right after a viewport change now shows the new viewport. Chromium applies a device-metrics override asynchronously, so on a busy machine the next capture could still return the previous surface (for example a 1280px frame after switching to a 390px phone viewport). The viewport action now waits, bounded, for the page to present a frame at the new size, and a viewport capture of an emulated device retries briefly until the surface has the emulated size, publishing what it has after 1.5 s at most.
- f182291: Browser observations now list the options of a short native select (up to 25) under its combobox, so an agent can see what it can choose before using select. Longer selects stay collapsed and still show their chosen option.
- 98eab8e: A tab opened after the agent sets a viewport now gets that size, as it would from a resized window, so the agent no longer has to set it again on every new tab. Tabs that were already open keep their own size, and each tab keeps its size when it is attached again.
- 49599e5: A browser `wait` for `visible` or `hidden` no longer fails with `locator_ambiguous` when its locator matches several elements. `visible` is satisfied when any match is visible and `hidden` when none is. Actions that target one element still refuse an ambiguous locator.
- 161d1b4: A live managed browser whose agent-browser socket and pid-record directory was removed (for example by a temp-directory cleanup) can be recovered again. Recovery treated the missing directory as an internal error (`ENOENT`, reported as `driver_failed`), so the browser could neither be resumed nor ended. A removed record directory now counts as holding no records, exactly like an empty one, and the proven browser is adopted and retired on its own, as it already was when its launcher had exited.
- 994c33a: A managed browser that was running during a macOS agent update is reattached afterwards instead of being lost: its daemon is identified by the path it was started from, which the update has removed. A reattach that fails, or that a controller restart cuts short, no longer leaves the browser permanently refused; once the browser is proven to be the same live process (or gone with its profile unused), the receipt it started from is reinstated so it can be continued or ended. On macOS, a browser whose version cannot be read launches with its own User-Agent, as on Linux.
- 2f6b8bd: A desktop observation now says when the accessibility tree is partial. When CUA stops reading a window early (a slow or very large app runs out its time budget, or the element limit is reached), the semantic snapshot carries `incomplete` with the reason and how many found elements were not read, and the model's text view ends with a line saying the tree is partial and to use the screenshot for anything not listed. Before, a partial tree looked complete, so a model could conclude a visible control did not exist.
- ead280c: A CUA `run_steps` batch that ran nothing now reports a plain failure instead of an operation of unknown outcome. When CUA rejects the batch while planning it, or stops at the first step before its action (the named target was not found, a `wait_for` check did not hold, or the batch ran out of time), nothing reached the app, so the model is no longer told not to replay it. A missing target reports `locator_not_found`. A batch that stopped after an earlier step ran, or in a step's action or `expect` phase, still reports an unknown outcome.
- 1254a18: macOS computer-use actions are much faster. A background accessibility click on a new element took about 1.5 to 2 seconds, almost all of it driver overhead around a press that takes a few milliseconds; it now takes about 0.7 seconds. The agent cursor stays visible but moves in 150 ms without a pause after each click (CUA's default made every move take at least 600 ms, and each action waits for the cursor to arrive). The CUA worker also no longer glides a hidden cursor or spawns `ps` to detect Electron apps before every click, key press, scroll and value change.
- 2a81601: Computer use now runs on CUA Driver 0.36. On macOS, drags are delivered to background windows without bringing them forward, background typing reaches editor surfaces and multi-window apps, and background actions no longer raise Chrome or re-activate the user's app. The batch tool `run_actions` is replaced by upstream's `run_steps`, which adds targeting by role and name, per-step waits and checks, and a diff of what changed (`observe: {}`). The new `run_script` tool runs a short sandboxed script against the same computer session for flows that need loops or branches; it has no filesystem, network or process access.
- 1337330: Desktop observations through the CUA backend now name table rows, list items and cells by the text they contain, so rows no longer read as empty elements.
- 658e69e: A browser linked to a Linux computer session starts again on hosts with a systemd user manager. The linked browser launches with the computer session's private D-Bus and runtime directory, so its transient-scope request reached a bus with no systemd manager and Chrome exited before DevTools came up (driver_failed). The scope request now always uses the user manager's bus that the launch probe verified, and Chrome still receives the computer session's own bus.
- 956ef74: Offscreen managed Chrome on a Mac with a Retina main display now presents that display at its real size. Chrome reads the screen it is given in device pixels, and the display was passed in points, so pages saw a screen half its size and smaller than the browser window (for example 864x559 around a 1280x633 viewport), a signal bot detection looks for.
- 790ac6e: Stop browsers and Desktops a task leaves running on a Connected Machine it moved away from. Retiring a browser now also stops one that an agent restart left running detached (its profile and downloads stay on disk) and every later request that notices the move retries earlier retirements of that task's browsers and Desktops that found the machine offline or refusing.
- Updated dependencies [e7113e3]
- Updated dependencies [9c0c567]
- Updated dependencies [2f6b8bd]
- Updated dependencies [9482fe0]
- Updated dependencies [2a81601]
- Updated dependencies [71dfe30]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [79ec9fd]
- Updated dependencies [5927aae]
- Updated dependencies [6ab7b55]
- Updated dependencies [3e061d6]
- Updated dependencies [a22ed79]
  - @opengeni/contracts@4.0.0
  - @opengeni/interaction@4.0.0

## 0.2.22

### Patch Changes

- 481f4b0: A page's missing icon no longer counts as a failed request. Chrome fetches `/favicon.ico` or a declared `<link rel=icon>` by itself, and on the many sites without one, every browser observation reported "1 failed request" that the page never made. Requests the page makes, including images, scripts and fetches, are still counted.
- a544972: Browser tool results now reach the model as a compact page outline instead of JSON: one line per element (`role "name" [ref] value states`), indented by nesting, with refs on controls and actionable elements and omitted on text and layout lines. Noise states are dropped. `browser_open`, `browser_tabs`, `browser_observe`, `browser_act` and accessibility `browser_read` use it; `structuredContent` keeps the complete typed value for Code Mode, the API and the UI. Element refs are shorter (`e`/`a` plus 8 hex digits, with the full digest on a collision within a snapshot). Together this roughly halves the tokens of browser tool output.
- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/contracts@3.4.0
  - @opengeni/interaction@3.4.0

## 0.2.21

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/contracts@3.3.0
  - @opengeni/interaction@3.3.0

## 0.2.20

### Patch Changes

- Updated dependencies [a0c35a1]
  - @opengeni/contracts@3.2.0
  - @opengeni/interaction@3.2.0

## 0.2.19

### Patch Changes

- 1739e1c: Returning an expired browser resume to its checkpoint now works on ordinary Linux machines. Before moving an interrupted launch aside, the controller proves that no process uses the browser's profile, and that proof also required reading every process's executable link. An agent running as a normal user can't read that link for root's or other users' processes, so the proof always failed and the browser stayed stuck with "Current browser is unavailable". The proof now relies on each process's command line, which is the only part that names the profile. A process whose command line names the profile, or whose command line can't be read, still blocks the move.
- 7304410: A browser restored from its checkpoint no longer fails to resume when one of its saved tabs can't load, for example because the site is down or its address no longer resolves. Before, the first tab whose page failed to load aborted the whole restore with "browser could not navigate to the requested URL", so the browser could never be resumed. Restored tabs now reopen on the browser's error page, as the browser's own session restore does. A tab showing an error page is also saved under the page it was trying to load instead of the error page, so a later restore retries it. Opening or navigating a tab outside restore still reports a page that can't load, and navigation policy refusals and invalid addresses still fail restore.
- Updated dependencies [17d61c6]
- Updated dependencies [1e67711]
- Updated dependencies [0bdb953]
- Updated dependencies [79af429]
- Updated dependencies [877c70d]
  - @opengeni/contracts@3.1.0
  - @opengeni/interaction@3.1.0

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
