---
"@opengeni/browserd": patch
---

A click on a control that takes the pointer only while it is hovered now waits for the hover to take effect. After the pointer moves onto the control, the hit test is repeated on the next drawn frames, for as long as the page is watched for a reaction. This fixes intermittent refusals in cross-origin frames, where the frame's process applies the hover after the move has returned, and controls that turn on a moment after the pointer rests on them are now clicked instead of refused. Controls that never take the pointer are still refused.
