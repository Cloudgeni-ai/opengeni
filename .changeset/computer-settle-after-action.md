---
"@opengeni/browserd": patch
---

On macOS and Linux computer use, the window reading an action returns now waits, for up to 5 seconds, while the action has started work the page shows in progress: a busy element or spinner, or a status, label or disabled control whose text ends in an ellipsis, such as "Saving..." or "Loading…", that the reading before the action did not show. The agent then sees the result of a save or load in the action's own receipt instead of observing again. An action on a page that shows no new sign of work reads the window once, as before.
