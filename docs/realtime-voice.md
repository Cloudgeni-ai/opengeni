# Session realtime voice

Realtime voice is an experimental, provider-neutral full-duplex media capability bound to one
existing OpenGeni session. It adds one compact persistent workspace voice overlay without
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

- The persistent overlay has two explicit modes. **This session** binds only to the session ID in
  the current route. **Workspace main** binds only to the ordinary session ID designated by the
  workspace's general `settings.mainSessionId`. A missing, deleted, or inaccessible target leaves
  that mode unavailable; neither mode silently falls back to the other or creates a session.
- The target session keeps its existing workspace permissions, tools, memory, child-session graph,
  approvals, queue/control semantics, compute target, and durable history.
- Input audio, partial transcripts, provider state, playback, and reconnect state are ephemeral.
  An accepted transcript becomes an ordinary durable session message; there is no alternate
  conversation store.
- Non-empty provider finals serialize through a bounded queue. Each provider acceptance ID binds
  to a deterministic ordinary Send `clientEventId` for the exact workspace and session. Voice
  never silently uses Steer. The final is acknowledged locally only after Send succeeds.
- If Send throws or returns false, that final remains `outcome-unknown`, media is revoked, and no
  automatic ambiguous resubmission occurs. A later explicit Start retries the same text with the
  exact same `clientEventId` before opening a new transport. Ordinary Send idempotency therefore
  collapses a response-loss replay instead of duplicating durable input.
- The pending-final queue and accepted-ID cache are deliberately memory-only transport state; they
  are never copied into browser persistence. After a true page remount, the gateway must redeliver
  every final whose durable acceptance was not acknowledged. The replay derives the same
  `clientEventId`, so ordinary Send idempotency recovers an ambiguous response without creating a
  second durable message. This redelivery/acknowledgement protocol is an activation requirement,
  not behavior proved by the deterministic fixture.
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
workspace overlay resolves explicit routed-session or configured-main target
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
grant. Mode/target changes, stop, unmount, terminal gateway messages, and physical socket close
locally fence callbacks and revoke recorder, microphone, playback, and socket ownership.

## Authorization

Realtime voice inherits the target session's existing boundaries:

| Operation | Workspace permission | Embedding-host session operation |
| --- | --- | --- |
| Read capability | `sessions:read` | `session.read` |
| Create short-lived grant | `sessions:control` | `session.append` |

Both routes verify that the exact target session exists. Workspace admins designate or clear the
Workspace main target through the general workspace settings API, which tenant-scopes and validates
the referenced ordinary session. This selection adds no global voice authority: capability/grant
checks still authorize the target session under the same rules.

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
- explicit retention (`inputAudio`, `partialTranscripts`, and `providerState` are ephemeral;
  `acceptedTranscripts` are `ordinary-session`); and
- advertised grant TTL, maximum session duration, maximum input-audio bytes, concurrent sessions,
  and optional workspace audio budget.

These limits are conservative policy/provider **advertisement hooks**, not claims of live metering
or enforcement. No production gateway exists. A future gateway must independently enforce
admission, cumulative bytes, elapsed session time, concurrency, workspace budget, resets, and
cleanup rather than trusting a browser or capability document.

The React controller and orb expose `authorizing`, `connecting`, `listening`, `speaking`,
`executing`, `awaiting-approval`, `reconnecting`, `closing`, `closed`, `error`, and `unavailable`
states. Recoverable transport loss requests a fresh short-lived grant for each bounded reconnect;
connection attempts time out, and the retry cap ends in a controlled error. Provider errors reach
the UI only as controlled local codes. The exact target label and session ID remain available to
assistive technology. Text fallback navigates to that exact ordinary session and focuses its normal
composer.

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
| Workspace target modes and ordinary-session bridge | `apps/web/src/components/session/realtime-voice-workspace-control.tsx` |
| Workspace-main designation UI | `apps/web/src/routes/workspace-settings.tsx` |
| Deterministic visual state fixture | `packages/react/demo/realtime-voice-harness.tsx` |

## What must be proved before enabling production voice

1. An authorized Codex-subscription audio/realtime endpoint, transport, entitlement, event grammar,
   audio formats, limits, reset signals, and terms must be mechanically established without using a
   paid Platform API.
2. A server-side OpenGeni media gateway must redeem short-lived target-bound grants, acquire and
   rotate Codex subscription credentials through the existing broker, keep tokens out of browser
   traffic and logs, enforce byte/time/capacity limits, redeliver unacknowledged accepted finals
   across reconnects and page remounts, and clean up on expiry or disconnect. It may acknowledge a
   final only after the ordinary durable Send reports success.
3. Gateway integration tests must prove target binding, authorization, credential non-disclosure,
   replay/expiry rejection, final redelivery and acknowledgement ordering, limit/reset handling,
   and no Azure or Platform fallback.
4. A safe live canary must separately prove microphone capture, full-duplex latency, interruption,
   reconnect, approval pauses, provider limits, and completed-message speech. Fixture screenshots
   remain UI evidence only.
5. Production rollout must retain the kill switch and complete normal deployment plus live
   acceptance. Implementation or merge alone is not production acceptance.
