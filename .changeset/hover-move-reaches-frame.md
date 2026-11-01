---
"@opengeni/browserd": patch
---

A click on a control that takes the pointer only while it is hovered no longer fails now and then in cross-origin frames. Chromium sometimes sends the pointer move to the page holding the frame instead of the frame, so nothing in the frame was under the pointer and the control was refused as if it never took the pointer. The move is now sent again, up to three moves in all, while the frame shows nothing under the pointer, and the page is watched for a reaction for a full window after the last move. Controls that never take the pointer are still refused.
