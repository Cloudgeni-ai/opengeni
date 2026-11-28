---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
---

Agents can link a recorded meeting as `[its title](meeting:<recordingId>)`, and a new `meeting_update` tool renames a meeting, shares it with the workspace or makes it Only me, and names its speakers, as the person could on the meeting page. `meetings_search` and `meeting_read` results carry each meeting's `link`. `parseOpenGeniLink` returns a `meeting` target (`parseMeetingReference` reads one href) and `openGeniConsolePath` maps it to the workspace's meeting page; the web console opens it in place, and a host that doesn't resolve it shows just its title.

Who can open a meeting is decided in one place, `meetingSharingTargets` and `meetingSharingDecision` from `@opengeni/contracts`, which the meeting page's Share menu and `meeting_update` both use, so they send the same request and refuse the same choices.
