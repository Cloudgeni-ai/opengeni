---
"@opengeni/browserd": patch
---

Desktop computer use: set_value on a web date or time field in a browser that is not the active app now fills it, by focusing each of its parts through accessibility before typing it. Before, pressing the field focused no part in the background, so every key was dropped. A field's "Show date picker" button now points to the field instead of opening a menu that would bring the browser in front, and a refused web dropdown menu says to choose its option with set_value instead of naming an input mode the tool does not offer.
