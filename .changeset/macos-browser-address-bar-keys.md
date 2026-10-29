---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

On macOS, typing into a browser's address bar in the background and pressing Enter now loads the page. The text used to be written through accessibility, which the address bar shows but never takes, so Enter loaded nothing while the batch reported success; it is now typed with keystrokes the browser does take. A `computer_act` batch whose raw input (a key press, or a press the driver could only send) went unconfirmed and that changed no element now says it may not have taken effect, as a single action does. Computer sessions report `targetFocus`, whether a focus action can bring a window forward, and `computer_open` lists "window focus" under what is not available where it cannot (CUA on Windows and Linux).

Pins CUA 944b1b7f (cu-browser-field-keys merged with cu-popup-options).
