---
"@opengeni/browserd": patch
---

Typing into a canvas that reads key presses, such as a remote-desktop viewer, now delivers the text asked for. `type` with `mode: "keys"` presses the key a person would press on a US keyboard for each character, holding Shift for uppercase letters and shifted symbols, and a modifier in `press` (for example `Ctrl+C`) now goes down as its own key before the main key and comes up after it, also when sending the key fails. A digit or symbol in `press` is its US key too (`!` is Shift and the 1 key), and a letter in a key combination is reported lowercase unless Shift is held (`Ctrl+A` sends `a`), as a browser reports it. Viewers that forward physical keys (scancodes) used to get lowercase letters and unshifted symbols, and symbols with no key at all were dropped.

Characters with no key on a US keyboard (such as `æ` or `é`) are still sent as text only. A text field takes them, but a canvas that reads key presses may not, so when one is sent while focus is not on a text field the result is `outcome_unknown` and names those characters.

`type` without `mode: "keys"` inserts text, which Chromium silently drops when focus is not on a text field (a canvas, a button, a grid cell that is not being edited, or the page itself), while the action reported success. It now fails as `invalid_action` before anything is sent, saying to focus a text field or use `mode: "keys"`. With a locator, the target is checked before it is focused; an element that holds a text field (a wrapper that moves focus into its field) is decided by where focus lands. Code editors that take text through EditContext (Monaco, VS Code for the web) count as text fields.
