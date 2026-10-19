---
"@opengeni/browserd": patch
---

Computer use on macOS, Windows and Linux: an action that names an element by a ref from an earlier observation of the same window now acts on that element instead of failing with "locator must resolve to exactly one observed element" (an action without fences is checked against a fresh observation, which mints new refs). A ref that is in no recent observation says so and names the current observation. When CUA refuses or cannot confirm an action, the failure now carries CUA's own reason and hint instead of only "refused the operation". On macOS, `super`, `command`, `win` and `opt` are accepted as modifier names. On macOS, computer_act's `launch` action now starts an app by bundle id or name in the background without taking focus (it was reported as unavailable, so agents had to use the shell); its windows then appear as targets.
