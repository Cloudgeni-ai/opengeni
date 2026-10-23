---
"@opengeni/browserd": patch
---

On macOS a web page's number field (`<input type=number>`) now shows as a `spinbutton` that offers `set_value`, instead of a raw `AXIncrementor` offering only invoke and a focus that failed. Its value is written as text and checked afterwards: a field that reads its old value or nothing instead of the number it was given fails the action, and CUA puts back the old value of a field a value emptied and refuses the write, so `set_value` (also as a later batch step that names the field) never silently clears it. `focus` on it works. A web range input given a value is stepped to it. The parts of a date or time field stay as they were.
