---
"@opengeni/browserd": patch
---

Browser `fill` sets sliders: a native range input takes the value directly (a value between its steps is refused with the nearest one it takes), and a custom `role="slider"` element is moved with its arrow keys until it reports the value. Page readings show a slider's or progress bar's numeric value and no longer list empty properties.
