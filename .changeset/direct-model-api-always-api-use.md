---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

The direct model API (`/v1/workspaces/:workspaceId/chat/completions` and its `/models` list) is now always API use, whatever credential signs the call. A person's own browser session or native app credential is billed like an API key: only purchased credit pays, never Free or other plan credit, and without credit the call is refused with `api_credits_required` and "Add credits to use the API." An agent's call keeps its chat's origin, a trusted in-process dispatcher's origin is kept, and internal (legacy) accounts stay app use. Chats and other app features are unchanged. `billingOriginOverride` in `@opengeni/db` reads the origin a trusted dispatcher fixed.
