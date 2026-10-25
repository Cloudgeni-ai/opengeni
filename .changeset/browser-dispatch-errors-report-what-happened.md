---
"@opengeni/browserd": patch
"@opengeni/interaction": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/runtime": patch
---

Browser actions no longer report an ordinary page error as a lost controller (`controller_lost`). A dispatch error the driver did not classify is `controller_lost` only when the browser or the connection to it is actually gone; when the browser still answers, or does not answer a short check in time, it is `driver_failed` with an unknown outcome and a message that says which. Inside a browser action, such an error is a definite `driver_failed` failure when no input was sent, and an unknown outcome that names the error once input was sent. When every action ran but the page could not be read afterwards (for example a page whose frames keep changing), the receipt is `completed` without an outline and carries a new `observation_unavailable` note saying so. Clicking an option of a native single-choice dropdown now chooses it, as a person would: the page sees input and change, and an open list then closes without a blur or focus event. A disabled or hidden option is refused. A selection change whose change handler opens a JavaScript dialog, from a click or the `select` action, is no longer reported as an action that did not run. Clicking any other element the page does not render is a definite `invalid_action` refusal, and one removed from the page is a stale-element `locator_not_found`. Receipt notes are now versioned: a caller asks with `receiptNotes=2` (`BROWSER_ACTION_RECEIPT_NOTES_VERSION`) to receive the new note kind, and older callers keep receiving only the kinds they parse.
