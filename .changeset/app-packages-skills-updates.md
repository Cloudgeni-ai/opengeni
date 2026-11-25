---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

App packages can carry Skills (`skills`, SKILL.md folders) and automations (`automations`, added switched off), and a `packageVersion`. Install adds the Skills as workspace Skills linked to the app; upgrades plan and update them (`plan.skills`, `plan.automations`, `plan.packageVersion`) and warn about changes made here (`plan.localChanges`). `AppPackageUpgradeRequest` takes `previous: true` instead of `package` to go back to the app's state before its last upgrade. `listAppPackageStatus` lists installed apps with their version, Modified, Skills, automations, a previous version and any ready-made update. The artifact catalog takes `excludeKind`. The console gets an Apps page (installed and ready-made apps, Update available, Restore previous version); Artifacts no longer lists apps, and its old Apps tab links open the Apps page.
