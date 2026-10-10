---
"@opengeni/api-router": patch
---

A key-only deployment (configured access mode) can now connect a Claude subscription to its workspace with the deployment key, from the console or the API. Before, the sign-in asked for an Opengeni browser sign-in that this mode doesn't have. Agents and requests without the exact key are still refused, and managed and local deployments are unchanged.
