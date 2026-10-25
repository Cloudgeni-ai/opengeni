---
"@opengeni/browserd": patch
"@opengeni/interaction": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/runtime": patch
---

Browser actions no longer report an ordinary page error as a lost controller (`controller_lost`). A dispatch error the driver did not classify is `controller_lost` only when the browser or the connection to it is actually gone; on a live browser it is `driver_failed` with an unknown outcome. Inside a browser action, such an error is a definite `driver_failed` failure when no input was sent, and an unknown outcome that names the error once input was sent. When every action ran but the page could not be read afterwards (for example a page whose frames keep changing), the receipt is `completed` without an outline and carries a new `observation_unavailable` note saying so. Clicking an option of a native single-choice dropdown now chooses it, as a person would, closing the open list; a disabled option is refused. Clicking any other element the page does not render is a definite `invalid_action` refusal. Receipt notes are now versioned: a caller asks with `receiptNotes=2` (`BROWSER_ACTION_RECEIPT_NOTES_VERSION`) to receive the new note kind, and older callers keep receiving only the kinds they parse.
