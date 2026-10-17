---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/worker-bundle": patch
---

The retained-image limit per workspace is now configurable. `OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_BYTES` sets the deployment default (5 GiB, unchanged), and `OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_OVERRIDES` gives individual workspaces their own limit as a JSON object of workspace id to bytes. The hard-coded `COMPUTER_SCREENSHOT_WORKSPACE_QUOTA_BYTES` contract constant is removed.
