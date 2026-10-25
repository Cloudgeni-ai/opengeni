---
"@opengeni/browserd": patch
"@opengeni/interaction": patch
---

A call naming a browser tab that no longer exists now says why it is gone and how to carry on, instead of only "browser target does not exist". When browserd stops a managed browser (after it goes unused for the idle release time, or when its controller restarts), it keeps the browser's tabs in the session directory. The next launch on that profile, and the relaunch after a lost browser process or a state capture, matches them to the tabs it reopened. An old tab ID then answers that the browser was stopped and relaunched, that its tabs reopened with new IDs and unsaved page input may be lost, and which reopened tab now shows its page. A tab the driver saw close says when, and whether a close-tab call or its page or someone using the browser closed it. Any other unknown ID says to list the current tabs and use one of their IDs. Every message still starts with "browser target does not exist". An action refused before dispatch because its tab is gone now keeps the driver's target_not_found code and explanation instead of a generic driver failure.
