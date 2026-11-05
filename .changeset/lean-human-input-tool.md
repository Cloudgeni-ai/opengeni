---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

`request_human_input` costs less on every model call: its description keeps the same rules in fewer words, drops what its schema already says, and no longer repeats the "Let the agent decide" instruction that the tool result carries when it applies. Its schema no longer sends `allowOther` (new choice questions always offer Other) or the `$schema` marker; calls are validated against the unchanged contract. A session created with `unattended: true` keeps getting no question tool, and the docs now say to use it, or `humanInput: false`, for sessions nobody answers. A tool result too large to show now names `files__files_get_download_url` and the shell only when the session has them; otherwise it says the result was saved, which reader the session is missing, and to call the tool again with narrower arguments if it can. A Skill review question whose strict-schema call carries `secret: null` is no longer rejected as altered.
