---
"@opengeni/browserd": patch
---

On macOS and Linux computer use, the window reading an action returns now waits while the action has started work the page shows in progress: for up to 5 seconds while a busy element or spinner shows, and for up to 2.5 seconds while a short text ending in an ellipsis, such as "Saving..." or "Loading…", shows on a text, label, status or disabled control that the window did not show before the action. This includes a disabled "Saving..." button that Chrome on macOS shows only within the page's description. The agent then sees the result of a save or load in the action's own receipt instead of observing again. Menu items such as "Move to…", typed field values, a control that only turns disabled, and longer texts cut short with "…" do not count, so such an action reads the window once, as before. The readings taken while waiting do not replace the ones the agent planned from, so their refs still act.
