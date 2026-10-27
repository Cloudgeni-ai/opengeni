---
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Meeting model prices now show only where the workspace pays them. `GET /recording-models` returns `usdPerHour` for a model on the workspace's own key, and for a deployment's model only where its use is charged in credits; otherwise it is null. The recorder's live transcript switch, on web and phone, then says nothing about cost instead of "Uses extra transcription credit", so people whose deployment covers transcription no longer see a provider's list price.
