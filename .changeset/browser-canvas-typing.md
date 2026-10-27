---
"@opengeni/browserd": patch
---

Typing into a canvas that reads key presses, such as a remote-desktop viewer, now delivers the text asked for. `type` with `mode: "keys"` presses the key a person would press on a US keyboard for each character, holding Shift for uppercase letters and shifted symbols, and a modifier in `press` (for example `Ctrl+C`) now goes down as its own key before the main key and comes up after it. Viewers that forward physical keys (scancodes) used to get lowercase letters and unshifted symbols, and symbols with no key at all were dropped. Characters with no key on a US keyboard are still sent as text only.

`type` without `mode: "keys"` inserts text, which Chromium silently drops when focus is not on a text field (a canvas, a button or the page itself), while the action reported success. It now fails as `invalid_action` before anything is sent, saying to focus a text field or use `mode: "keys"`.
