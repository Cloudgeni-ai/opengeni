---
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Fresh compute sandboxes can now start with a Sandbox Environment's setup already done. Verification captures the set-up sandbox as a compute template, proves it with a separate cold boot, and new sandboxes start from it. Previously, every fresh compute sandbox ran the whole setup script again. A template is tied to the compute image name and the deployment revision, so each release builds a new one. On compute, a version with setup that has no template, a failed or stopped build from an earlier release, and a build abandoned mid-way each ask once for a background build; a failed build of the current content waits for the next release. A build deletes only a template it created and no other build now owns. A capture is requested once and, if its answer is lost, found by name. A turn looks up the compute team once with a short timeout and remembers a failure briefly. A template deleted after it was chosen falls back to the plain image and the ordinary setup.
