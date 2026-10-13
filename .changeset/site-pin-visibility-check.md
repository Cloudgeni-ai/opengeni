---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Pinning a Site checks that the caller can see it with a single lookup (`isWorkspaceArtifactVisible`) instead of loading the Site's full history, and the artifact catalog route tests now cover the Site audience: catalog Sites carry `visibility`, and pinning someone else's Only me Site answers 404 without writing a pin.
