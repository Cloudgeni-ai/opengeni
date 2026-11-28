---
"@opengeni/browserd": patch
---

A computer action's result now names the frame of the screenshot last shown, not the capture the action took to send its input. A click captures the window at full size and returns no image of it, while a screenshot is usually scaled down, so a second click sent on the frame named in the first click's result, with the pixels of the screenshot the agent was looking at, landed somewhere else (on a Simulator window shown at 360x768 but 444x948 natively, about 30 pixels off). Observations and results now name only frames an image was returned for. Pointer input still scales into the latest capture as before.
