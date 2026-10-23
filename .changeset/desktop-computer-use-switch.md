---
"@opengeni/agent-host": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/desktop": patch
---

In the desktop app, the computer you're on is now **Computer use**: one on/off switch in Settings > Machines (and at the top of **Connect a machine**) instead of Turn on, Pause, Turn off and the old "Connecting …" card. It shows one state at a time: off (the same whether never set up, turned off, or removed from Machines), turning on, on, or a problem with exactly one fix (**Allow in System Settings**, **Sign in**, or **Try again** with the server's own message). Before, a computer removed from Machines kept saying "Connecting …" forever with "Couldn't reach the server" although the server had answered; now removal is detected and shows as off, and turning it on registers the computer again. Only a server that really can't be reached says so (new `ThisComputerErrorCode` values `removed` and `signed_out`; `machineReadFailure` classifies failed reads, and `ThisComputerDeps.readMachine` resolves null only when the server answered without the enrollment).

Off is pause, so it survives restarts and keeps the registration; turning on resumes, re-registers or starts the agent as needed and opens the permission steps only when something is missing. An agent already registered to the workspace from the web app's install command is adopted and shows as on with nothing to do. The sidebar shows a small notice only while computer use turns on or has a problem. Inside the app, **Connect a machine** no longer offers downloads or **Open app and connect** for this computer; in a browser it is unchanged. `useThisComputer` gains `turnOn`, `turnOff` and `pending`; `@opengeni/react/this-computer` exports `computerUseState` and `useComputerUse`, and the desktop app exports `DesktopComputerUseRow` and `useDesktopComputerUse`.
