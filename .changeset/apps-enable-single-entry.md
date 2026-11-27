---
"@opengeni/react": patch
---

`AppsRoute` takes an optional `onChooseReadyMade(templateKey)`. When it's set, choosing a ready-made app on the Apps page calls it (the Opengeni app opens the app's Enable page, the one place a ready-made app is added) instead of opening the install dialog. Without it the dialog stays. Each ready-made app's tile now gets its own hue from its package, and an installed app from that package keeps it (`ArtifactItemExtras.seed`).
