---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/interaction": minor
---

On macOS, the controls of a web page in Chrome or another Chromium app can be invoked again: Chrome lists no press action on page elements in the accessibility mode Opengeni enables, so buttons, links, checkboxes and similar page controls showed no actions and invoking them was refused. Selects still take set_value. A pointer click on Chrome's own window controls, such as a background tab, is now sent as a pixel click instead of being reported as done while nothing happened. A keyboard shortcut whose menu item macOS keeps disabled while the app is in the background (Terminal's Close Window) reports that it most likely did nothing, instead of completing.

Computer action receipts gain an optional `unconfirmedInput` field: the action's click or key press was delivered without any confirmation that the app acted on it. Controllers return it only to callers that ask with the `receiptUnconfirmedInput` query parameter. When it is set and no element changed, the agent's result says the input may not have taken effect.
