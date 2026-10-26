---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Meetings transcribe with a model the workspace can use. When nothing names a model, a meeting runs the deployment's default if this workspace can use it, else the first model in the provider order that serves meetings and is usable here, so a workspace signed in to a ChatGPT or SuperGrok subscription, or holding its own key, no longer fails with "No transcription provider is connected". `meetingModelFor` resolves it, and `GET …/recording-models` reports it as `default`.
