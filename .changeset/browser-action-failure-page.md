---
"@opengeni/browserd": patch
"@opengeni/interaction": patch
---

A failed browser action now returns the page as it is after the failure, the same outline a successful action returns, so the agent can act on current elements (for example the fresh ref of a control that re-rendered) without a separate observation. Fill on something that is not a text field (a native select, a custom combobox, a checkbox) is refused before any input with the action that works on it, instead of typing into it and reporting an unknown outcome. Observations now show the chosen option of a non-editable combobox, such as a native select; typed text in editable fields stays hidden.
