---
"@opengeni/react": patch
---

The chat no longer jumps or shows a large blank area during long agent turns. A whitespace-only assistant message (some models send one around every tool call) is no longer turned into an empty timeline row, so dozens of them no longer stack their row gaps into a blank band or nudge the view up with nothing new on screen. A work row's toggle that stays focused after a click now anchors only the commit in which it opens or closes, so the view no longer chases that row while the answer streams above it and then snaps back by the answer's height when the turn settles. Closing a work row while at the very end of the chat resumes following new output.
