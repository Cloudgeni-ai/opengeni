---
"@opengeni/agent-host": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Turning on computer use in the desktop app no longer spins forever. When it is on but still not usable after a minute, the switch stops saying "Turning on…" and says why in one line: the server isn't accepting the computer's sign-in, the server can't see it yet, the agent isn't starting, another copy of the agent is in the way, or moving the agent into the app is taking too long, with the agent's own words below when it gave some, and **Try again**. Try again restarts an agent that is already running (its service, or the app's helper), so it signs in and connects right away instead of after its backoff. An agent that has stopped retrying because the server needs it connected again is a problem at once, and turning it on reconnects it. The app's own agent is no longer shown as on, and the menu bar no longer calls the computer available, while the server is refusing its sign-in. `parseConnections` reads each connection's `authentication` state from `opengeni-agent connections`; `ThisComputerStatus` gains `waitingOn` and `waitingDetail`, and `ThisComputerErrorCode` gains `reconnect_required`; `useThisComputer` gains `stalled` and a `turnOnLimitMs` option; `@opengeni/react/this-computer` exports `computerUseStalledText`; `ComputerUseProblem` gains `stalled`.
