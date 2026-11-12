---
"@opengeni/contracts": patch
---

In chat, the agent can read the workspace tool catalog and its declarations through app actions again. These reads were treated as handling a secret because the SDK client that serves them also serves tool approvals, which return an approval token. The app action catalog now names exactly what each of these two reads returns.
