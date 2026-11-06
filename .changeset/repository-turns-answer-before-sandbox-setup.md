---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A chat with a repository attached answers without first waiting for its sandbox. Before, indexing the repository's skills was the first sandbox operation, so the first model request waited for the box to start, the custom environment setup to run and the repository to clone (over a minute and a half on staging for a one-word prompt). Now a repository turn on a lazily provisioned managed box prepares the box, environment and clone in the background. The first sandbox tool call joins that same preparation, so setup never runs twice and a setup failure is reported on that call. Repository skills are still indexed from the live workspace when the box was already running and finishes its per-turn preparation within a short budget; otherwise the model is told the workspace is still being prepared and which skill folders to check. A turn that ends without using the box stops the preparation it never needed: no further progress is published for it, and the timeline drops its still-running setup rows instead of leaving them spinning or calling them ready.
