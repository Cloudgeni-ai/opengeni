---
"@opengeni/sdk": patch
---

Record the one-off release-policy decision for PR5165. Bendik (bendik@cloudgeni.ai) approved shipping the existing declaration unchanged—SDK/contracts minor and React patch—at **06:21 UTC on October 21, 2026** (PR5165 comment6309551766). This documentation-only patch entry does not replace or change that declaration. The decision is recorded in the append-only exception log in `docs/design/api-compatibility-policy.md` and resolves the previously pending version-policy decision described in the realtime response compatibility note.

`sessionRealtimeTransportKind` now returns `websocket` rather than the deprecated `gateway` and `xai-subscription` names. Update comparisons and switch branches that depended on those return values. The legacy negotiation helpers and transport starters remain available and deprecated; their continued presence does not preserve the old helper return values or old strict response shape.

The rationale is that the bounded audit found **no known incompatible production consumer**, not proof of zero usage. Historical Gateway counters exist, callers remain unidentified, and deployed client bundles were not proven. This is an explicit one-off exception to the usual major-version/retained-behaviour sequence, not a security exception or permission to weaken future compatibility review.

The existing response compatibility disclosure remains applicable: validators must allow `protocol`, `protocols`, and nullable `sessionUpdate`; new clients require compatible server responses and do not gain an old-server 404 downgrade. Published Site embedded chat remains HTTP/SSE, with Site voice pre-existing unsupported and outside this release's scope. This note does not qualify bidirectional rollout/rollback or grant release clearance; independent review and normal release gates remain required.
