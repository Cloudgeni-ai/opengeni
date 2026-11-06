---
---

A desktop test for sign-in links now waits for the sign-in to finish instead of a fixed 20 milliseconds, so it no longer fails on macOS, where reading the computer's name before opening the browser can take longer. Tests only; nothing ships.
