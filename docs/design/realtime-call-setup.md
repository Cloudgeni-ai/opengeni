# Realtime call setup

## Evidence and target

The target is roughly one second between Answer (or starting an outgoing call)
and hearing the agent. Three observed incoming calls before this change had the
following critical paths. These are server timestamps from the answered-call,
realtime-mode, connection and physical subscription-request ledgers, not a
measurement of the first audible phoneme on the phone. Values are milliseconds,
rounded independently.

| Stage | A | B | C |
| --- | ---: | ---: | ---: |
| Answer claim to realtime mode creation | 575 | 641 | 330 |
| Mode creation to connection claim | 546 | 116 | 102 |
| Connection claim to provider config request | 164 | 117 | 80 |
| Provider configuration request | 1300 | 920 | 967 |
| Between configuration and call requests | 85 | 146 | 57 |
| Provider call creation request | 2123 | 1567 | 835 |
| Provider response to saved SDP answer | 19 | 36 | 39 |
| Saved SDP to acknowledged provider startup | 900 | 1471 | 657 |
| **Answer claim to startup acknowledgement** | **5711** | **5014** | **3067** |

The HTTP negotiation envelopes for B/C were 2831/2003 ms. Answer HTTP handling
itself was 32/18 ms; catalog HTTP handling was 42/43 ms; begin HTTP handling was
206/192 ms. The gaps include network, device scheduling and uninstrumented
server work: they must not be attributed entirely to the microphone or database.
The observed deployment exposed HTTP logs and Prometheus, not an exported trace
backend. Historical token, history and lease substeps therefore cannot be
separated retrospectively. The new `Realtime setup phase completed` logs report
owner, candidates, lease, history, token, config, pre-dispatch fence, provider
call, and release durations under the request trace ID, with no request content.

## Design

- The native call host resolves the existing client/workspace-scoped catalog
  before a call. Ringing mounts the same call component that Answer will use,
  loading session data, events and control state without presenting an in-app
  call screen or starting/recovering a realtime mode.
- The shared SDK controller can prepare a local peer connection, data channel,
  and a sendrecv audio offer with a null sender track. No microphone permission
  request, capture, server mutation or provider call occurs during preparation.
  Answer attaches the microphone with `replaceTrack` and consumes that exact
  offer. A host without transceivers reuses the peer/channel and creates SDP
  after acquiring audio. Outgoing calls prepare alongside admission/capture.
- Decline, remote settlement, ring timeout, disposal and a hang-up during the
  answer claim release preparation. Late asynchronous work cannot start voice
  after disposal. The successful answer keeps the mounted component and peer.
- Microphone permission/capture stays at Answer, concurrent with admission.
  Prompting before Answer would interrupt ringing and capture before acceptance;
  platform call-audio activation is still owned by the native call adapter.
- The server reads history concurrently with token/config resolution, after
  owner/credential selection. Both branches settle before the operation lease
  releases. The same history/instructions are sent, and a 401 still permits
  exactly one credential refresh. No other call outcome is replayed.
- Successful provider configuration is cached for five minutes in each API
  process, scoped to organization, connection, provider account, client version,
  and FedRAMP mode (and isolated by injected fetch implementation). It is bounded
  to 256 entries. Unknown/network fallbacks are not cached. A positively observed
  unsupported protocol uses the existing pinned fallback and can be cached.
  A rejected call invalidates its entry for the next call. Authority and operation
  leases are always checked live. Pending authenticated fetches are not shared:
  their lease and cancellation belong to the initiating request.

## Why not create the provider call while ringing?

Not in this change. The existing begin operation claims an answered call and
freezes authority; starting it during ring changes session ownership and may
block normal agent work. Provider call creation also commits subscription work
and sends session context before a person accepts. Several ringing phones would
create several provider calls, including declined, timed-out and losing answers.
Closing the local peer does not prove remote creation was cancelled, particularly
when an HTTP outcome is unknown. The implemented provider protocol has no proven
transport-only prepare/hold/release contract for suppressing the opening without
losing or changing model-visible output.

This is a deliberate semantic boundary, not a one-second claim. A cached config
removes one observed 0.92–1.30 second round trip; ring preparation removes the
post-answer catalog/session-loading waterfall and local offer work. Provider
creation alone was 0.84–2.12 seconds, before media connection and actual speech.
Reaching one second reliably needs a verified provider-level held-call contract
(single ownership, explicit release on Answer, terminal cleanup and accounting)
or a faster provider path. Model instructions, initial items, opening behavior
and transcript injection are unchanged here.

## Verification boundaries

Tests cover account/version/TTL isolation, failed config reads, authentication-only
retry, parallel history/token/config work and lease lifetime; native ring/answer/
decline/timeout/remote-settlement/disposal races; local offer consumption, late
preparation cancellation, microphone attachment and resource cleanup.

A real Chromium loopback using the actual SDK preparation/transport created an
offer with zero microphone tracks in 70.4 ms, then connected the data channel
33.9 ms after the test Answer. Replacing the null sender track delivered audio
(1894 outbound bytes in the first 500 ms). This verifies WebRTC mechanics, not
provider latency or physical iOS/Android audio. Production after timings require
the merged server and mobile release; do not substitute loopback timings for
answer-to-audible measurements on a phone.
