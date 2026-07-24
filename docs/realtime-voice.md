# Session realtime voice

Realtime voice is an experimental, provider-neutral full-duplex media capability bound to one
existing OpenGeni session. It adds a compact persistent voice orb to the session page without
creating a voice-only thread, a second agent runtime, or a new authorization model.

## Current production status

**Unavailable by design.** OpenGeni has not mechanically verified an authorized Codex-subscription
audio/realtime endpoint, entitlement, or wire protocol. The production evidence constant is
therefore `unverified`, the OpenGeni media gateway is not implemented, and the feature kill switch
defaults off. A production grant request returns a typed unavailable capability with reason
`codex_realtime_protocol_unverified`; it does not resolve a subscription credential, request a
microphone, open a provider connection, or silently use another provider.

The deterministic tests and browser fixture exercise the public boundary and UI states only. They
are not evidence of a live microphone, provider session, entitlement, latency, or audio quality.

## Product and durability contract

- The orb targets the exact normal session shown on the page. That session keeps its existing
  workspace permissions, tools, memory, child-session graph, approvals, queue/control semantics,
  compute target, and durable history.
- Provider audio, partial transcripts, playback state, and reconnect state are ephemeral media.
  They do not create an alternate conversation store.
- Each non-empty accepted final transcript is deduplicated by the provider acceptance ID and sent
  through the ordinary composer **Send** operation. Voice never silently uses Steer. A blank final
  does not consume its ID, so a corrected non-empty final can still be accepted once.
- The agent executes the accepted text as an ordinary durable turn. Existing session status drives
  the orb's executing and approval states.
- Only completed, non-streaming assistant text already present in the durable session timeline is
  eligible for speech. Streaming deltas and provider-only output are never spoken as durable truth.
- The browser drops binary audio unless it requested speech for that completed durable message and
  the gateway acknowledged the exact message ID with `speaking.started`; unsolicited or
  mismatched provider audio is never played.
- Barge-in interrupts playback only. It does not cancel, pause, steer, replace, or otherwise mutate
  an accepted durable turn.
- The ordinary editable text composer remains available in every state, including permission
  denial, reconnect, provider error, and capability unavailability.

This is intentionally different from [composer transcription](transcription.md). Composer
transcription produces editable draft text and never sends it. Realtime voice maintains an active
conversation and submits accepted utterances through ordinary Send. The two capabilities have
separate workspace policies and acceptance IDs; enabling one never authorizes the other.

## Trust boundary and data flow

```text
session page for exact workspaceId + sessionId
  -> GET the session-bound voice capability
  -> fail closed unless the feature, subscription, workspace policy,
     verified protocol, OpenGeni gateway, credential, and capacity checks pass
  -> POST for a short-lived opaque OpenGeni grant bound to the same target
  -> only then may the browser request microphone access
  -> browser connects only to the grant's wss:// OpenGeni gateway URL
  -> Codex subscription credential remains inside the server-side gateway boundary
  -> accepted final -> ordinary composer Send -> normal durable session turn
  -> completed durable assistant message -> ephemeral speech playback
```

The public capability and grant contain no provider token, account identifier, credential handle,
provider endpoint, or raw provider error. A grant carries only an opaque grant ID, exact target,
provider-neutral protocol name, OpenGeni WSS gateway URL, and expiry. The browser adapter cannot
construct a public OpenAI, Azure, or other provider URL from this contract.

Construction of the browser adapter is side-effect free. `getUserMedia` runs only inside
`connect`, and React invokes `connect` only after receiving an available capability and non-null
grant. Target changes, stop, and unmount locally fence late callbacks and close the prior transport.

## Authorization

Realtime voice inherits the target session's existing boundaries:

| Operation | Workspace permission | Embedding-host session operation |
| --- | --- | --- |
| Read capability | `sessions:read` | `session.read` |
| Create short-lived grant | `sessions:control` | `session.append` |

Both routes verify that the exact target session exists. A future global orb must target the
already-existing main orchestrator session through these same rules; it must not create a global
workspace voice authority or a separate voice session.

## Codex-subscription evidence and fail-closed gate

The existing authorized Codex integration mechanically covers:

- HTTP Responses requests through the ChatGPT/Codex subscription backend;
- the subscription model catalog;
- usage/limit readback and reset timing; and
- the subscription connector MCP surface.

Those paths do **not** establish an authorized audio WebSocket or WebRTC endpoint, realtime event
grammar, audio formats, session limits, or entitlement. The public OpenAI Realtime API is a
different billable Platform API and is not an inferred fallback. Azure-hosted inference is also not
a fallback. Until independent evidence proves the Codex-subscription protocol and a separately
implemented OpenGeni gateway brokers it server-side, production remains unavailable even if
`OPENGENI_CODEX_REALTIME_VOICE_ENABLED=true`.

Two independent gates prevent a flag-only activation:

1. `CODEX_REALTIME_PROTOCOL_EVIDENCE` must be changed from `unverified` only with mechanical
   endpoint, transport, entitlement, and event-protocol proof.
2. The OpenGeni gateway must separately report itself available and implement bounded credential
   resolution, lease/rotation reuse, target-bound grant redemption, media proxying, usage/reset
   handling, and cleanup.

Changing either gate alone cannot make the capability available. Credential resolution occurs only
after feature, subscription, protocol, workspace-policy, and gateway checks pass.

## Public capability and lifecycle

The capability response reports:

- exact `workspaceId` and `sessionId` target;
- experimental provider and full-duplex mode;
- `available`, `disabled`, or `unavailable` status with a controlled reason;
- individual feature, subscription, workspace-policy, protocol, gateway, credential, and capacity
  checks;
- optional reset time for a capacity-limited provider; and
- advertised grant TTL, maximum session duration, and maximum input-audio bytes.

The React controller and orb expose `authorizing`, `connecting`, `listening`, `speaking`,
`executing`, `awaiting-approval`, `reconnecting`, `closing`, `closed`, `error`, and `unavailable`
states. Provider errors reach the UI only as controlled local codes. The exact target label and
session ID remain available to assistive technology, and the text fallback is always one action
away.

## Canonical implementation

| Concern | Canonical source |
| --- | --- |
| Workspace policy, capability, grant, and exact-target validation | `packages/contracts/src/index.ts` |
| Codex protocol evidence, fail-closed gates, limits, and server-only gateway seam | `packages/codex/src/realtime.ts` |
| Runtime kill switch | `packages/config/src/index.ts` |
| Capability/grant routes and host authorization classification | `apps/api/src/routes/sessions.ts` |
| Framework-neutral public adapter types and SDK client methods | `packages/sdk/src/realtime-voice.ts`, `packages/sdk/src/client.ts` |
| React lifecycle and durable-turn reconciliation | `packages/react/src/hooks/use-realtime-voice.ts` |
| Browser OpenGeni-gateway transport | `packages/react/src/realtime-voice/browser-adapter.ts` |
| Compact persistent session UI | `packages/react/src/components/realtime-voice-orb.tsx` |
| Deterministic visual state fixture | `packages/react/demo/realtime-voice-harness.tsx` |

## What must be proved before enabling production voice

1. An authorized Codex-subscription audio/realtime endpoint, transport, entitlement, event grammar,
   audio formats, limits, reset signals, and terms must be mechanically established without using a
   paid Platform API.
2. A server-side OpenGeni media gateway must redeem short-lived target-bound grants, acquire and
   rotate Codex subscription credentials through the existing broker, keep tokens out of browser
   traffic and logs, enforce byte/time/capacity limits, and clean up on expiry or disconnect.
3. Gateway integration tests must prove target binding, authorization, credential non-disclosure,
   replay/expiry rejection, limit/reset handling, and no Azure or Platform fallback.
4. A safe live canary must separately prove microphone capture, full-duplex latency, interruption,
   reconnect, approval pauses, provider limits, and completed-message speech. Fixture screenshots
   remain UI evidence only.
5. Production rollout must retain the kill switch and complete normal deployment plus live
   acceptance. Implementation or merge alone is not production acceptance.
