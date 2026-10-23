---
"@opengeni/react": minor
---

The status area above the composer takes less height, leaving more of the conversation visible on laptops and phones. The wait status is now one chip in the `SessionChrome` row (reason and next check time, details on tap) instead of a two-line banner; pass it with the new optional `wait` prop. Goal pause and clear moved into the goal panel, and a plain file attachment shows on one line.

`SessionChromeSignalId` gains `"wait"`, so exhaustive switches over it need a new case. The existing goal message keys (`sessionChrome.pauseGoal`, `resumeGoal`, `clearGoal`) are kept and now name the goal panel's buttons.
