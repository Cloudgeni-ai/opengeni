---
"@opengeni/browserd": patch
---

An address typed into a new Chrome tab in the background now loads when Return is pressed. A Chromium window in the background reports no focused element until it is the key window, and the CUA driver checked for the browser's own field before making the window key, so right after `cmd+T` the address bar was missed: the text went in through accessibility, the bar showed it, and Return loaded nothing while every step reported success. The pinned driver now decides this once the window is key and types the address as keystrokes.
