---
"@opengeni/react": patch
---

A chat now labels a run of an automation "Automation run" ("2 automation runs" when several arrive together), and the composer chrome calls its source "Automation". It used to say "Scheduled update" and "Schedule" even when an event or a manual run started it. The message keys changed accordingly: `machineInputDisplay.scheduledUpdate` and `machineInputDisplay.scheduledUpdatesCount_other` are now `machineInputDisplay.automationRun` and `machineInputDisplay.automationRunsCount_other`, and `sessionChrome.schedule` is now `sessionChrome.automation`. Hosts that translate these keys should rename their entries.
