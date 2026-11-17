---
"@opengeni/browserd": patch
---

Managed browsers on desktop sandbox images can now be continued after their controller restarts. The image's browser wrapper added its own default profile switch in front of the controller's, so the controller could never identify the browser it launched and every such browser became unusable after a restart. The wrapper now adds its default profile only when the caller names none.
