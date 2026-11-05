---
"@opengeni/react": patch
---

Machines and the Runs on menu now describe a computer the way a person picks one: "Mac", "Linux" or "Windows", and whether agents can use its screen ("Agents can use its screen", "Screen not shared", "No screen"), instead of "selfhosted · macos/aarch64 · headless". The exact system stays in the platform's tooltip. Inside the desktop app, the Runs on menu marks the computer the app runs on as "This computer". Settings → Computer use no longer shows switches that look off and can't move when a separately installed Opengeni Agent runs the computer: the screen and Chrome rows say what is in effect, from the workspace's machine list and connected browsers, and that the separate agent decides it. The warning that a change restarts the agent shows only where the switches work.
