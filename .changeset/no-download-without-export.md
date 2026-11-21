---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Editable artifacts no longer show a Download button on a deployment that cannot export them. The client configuration now reports `artifactExport` (whether the artifact materializer is deployed), and the web console offers Download only when it is not `false`. Before, the button was always shown: each click saved a named version, then failed with "Download failed. Try again."
