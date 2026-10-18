---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/runtime": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
---

Add an opt-in `compute` sandbox backend for the Opengeni compute fabric. Each compute sandbox runs the Opengeni machine agent with no credential; its fabric host carries the agent's traffic over one link to a new agent gateway in the API, so the sandbox gets the same session as a Connected Machine and a message to a sleeping sandbox wakes it. Opengeni creates the sandbox's enrollment itself (kind `sandbox`, bound to its sandbox group, never listed or attachable as a Connected Machine), treats the sandbox as a managed sandbox, and deletes it and revokes the enrollment when its group ends. Configure it with `OPENGENI_COMPUTE_API_URL`, `OPENGENI_COMPUTE_API_KEY`, `OPENGENI_COMPUTE_LINK_URL` and `OPENGENI_COMPUTE_IMAGE`; the default backend is unchanged.
