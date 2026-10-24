---
"@opengeni/react": minor
---

A turn that takes more than a second to load its conversation history before the first model request now shows it as a "Loading conversation history" startup step, with its duration in startup timings, instead of a silent wait. `StartupPhase` gains `"history"`.
