---
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Fresh compute sandboxes can now start with a Sandbox Environment's setup already done. Verification captures the set-up sandbox as a compute template, proves it with a separate cold boot, and new sandboxes start from it. Previously, every fresh compute sandbox ran the whole setup script again. A template is used only while the image it was built over is current: a digest-pinned image, or an image name together with the deployment revision. A version that was never built for its backend is built once in the background. A template deleted after it was chosen falls back to the plain image and the ordinary setup.
