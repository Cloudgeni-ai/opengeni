---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

Browser passkeys are now bound to the agent attempt that loaded them. Before an action by a person or an API key, the API empties the browser's virtual authenticators, so passkeys loaded for an earlier attempt can't be used by someone else driving the same browser. The passkey sync names the attempt it acts for in a new `owner` query parameter, which older controllers ignore. A current controller records the owner of each credential set, stamps every page registration with it, and doesn't carry one owner's unsaved registrations into another owner's set. The API saves a registration only for the attempt whose set was loaded when the page registered it; any other registration is acknowledged and dropped. Sign counts the browser has seen survive a reload.
