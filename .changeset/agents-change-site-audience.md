---
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Agents can change who can see an existing Site, for the person they act for, with the same rules as the Site page: `sandbox_file_publish` with the Site's `artifactId` and `visibility` shares it with the workspace or makes it Only me at the same link, instead of publishing a copy. Only the Site's owner (or their agent) can change it, sharing needs permission to publish Sites, and Only me must be allowed for the owner. The result says who can now open the Site.
