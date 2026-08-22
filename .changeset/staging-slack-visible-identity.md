---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/deployment": patch
"@opengeni/sdk": patch
---

Allow the managed staging Slack app and bot to use the visibly distinct `OpenGeni Staging` identity. The manifest, runtime configuration, installation verification, durable binding contract, SDK, web projection, and deployment artifacts now preserve one closed environment-qualified display-name setting while production continues to default to `OpenGeni`.
