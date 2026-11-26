---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/api-router": patch
---

People can put the rail's built-in entries in their own order. "New session", Inbox, Agents, Apps, the Setup group and the pages inside it can be dragged to another place, onto Setup's name to move a page into it, or out of it; Alt+ArrowUp and Alt+ArrowDown move the focused entry one place. The order is saved in the person's own layout as two new options, `navOrder` (the top, with `setup` for the group and `new_session`) and `navSetup` (inside the group). Entries an order doesn't name keep their place, and Reset brings back the default. `sidebar_layout_update` takes the same options.

`@opengeni/react` exports `RailNewSessionLink`, and a surface that sets the new `primaryNavPlacesNewSession` slot places "New session" among its own entries.

Insights usage broken down by agent shows each agent's own avatar beside its name, as the Agents page does, and its initials only when it has none.
