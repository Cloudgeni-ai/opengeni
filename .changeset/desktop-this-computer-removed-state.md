---
"@opengeni/agent-host": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/desktop": patch
---

"Use this computer" in the desktop app now shows where the computer really stands after it is removed from Machines. Before, the settings card and the sidebar kept saying "Connecting …" forever with "Couldn't reach the server", even though the server had answered. Now a computer the server no longer lists shows as removed, with one **Reconnect** action that connects it again with a fresh enrollment, and the settings card, sidebar, chat card and setup steps agree. A machine list that can't be read keeps its own reason: offline, signed out (new `ThisComputerErrorCode` values `removed` and `signed_out`), or the server's error, never a network failure when the server answered. `ThisComputerDeps.readMachine` now resolves null only when the server answered without the enrollment and rejects when it couldn't be read; `machineReadFailure` classifies those failures.

The setup steps show one state at a time and follow the computer's own status, so "You're all set" never appears while the agent is still being waited for, and they fall back when it stops reporting or is removed. Inside the desktop app, **Connect a machine** shows this computer's state with one action instead of downloads and **Open app and connect**; other computers and servers still connect with a command or a code. In a browser the dialog is unchanged. `ThisComputerLabels` gains optional `removed` and `reconnect`.
