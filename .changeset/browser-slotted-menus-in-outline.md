---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/codemode": patch
---

Browser outlines now show a visible custom menu that a web component puts on screen through a shadow-root slot, and role, text and ref locators reach its items. Chromium updates its accessibility tree incrementally and leaves out content assigned to a slot after the slot was laid out, so such a context menu was on screen but missing from the outline and `locator_not_found` for every semantic locator; browserd now rebuilds the tree on each read. Text that CSS generates keeps its ref across these rebuilds. Text and label locators also take `exact` (whole accessible name, ignoring case and spacing), as role locators do: the browser action schema already showed the field, but the server rejected it on those kinds. Code Mode `getByText` and `getByLabel` take it as their second argument.
