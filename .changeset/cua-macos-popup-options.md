---
"@opengeni/browserd": patch
---

On macOS, choosing an option of a dropdown no longer opens or leaves open its menu in a window behind the person's. Invoking an option of a dropdown (an item of its open menu, or the option a closed browser dropdown shows) chooses that option on the dropdown, as `set_value` does, instead of pressing the item: a browser dropdown took such a press as a choice and opened its menu again, raising its window, and a closed one's option could bring the browser down. `set_value` on a browser dropdown in a background window of the front browser now types the option's text instead of opening the menu, a menu still open after a choice is closed, and a pointer click on the option a closed browser dropdown shows is refused like one on the dropdown. A native combo box reads as a `combobox` that takes `set_value`, and its app takes the new value as chosen.

Pins CUA fe18680a.
