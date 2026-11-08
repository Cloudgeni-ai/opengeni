# Agent calls

An agent can ring a person's phone for a live voice conversation. The phone
shows the platform's own incoming-call screen (CallKit on iOS), including on the
lock screen. Answering joins the chat's existing voice call, which opens by
saying why the agent called, and the conversation lands in that chat.

## Principles

- **Off until the person turns it on, per phone.** Nothing rings until the
  person turns on "Let agents call this iPhone" in the app's settings on that
  phone. A second switch, "Teammates' agents too", lets agents working for other
  members of the workspace call them. Both are off by default.
- **The agent picks a person, never a device.** By default it calls the person
  it works for. Every phone of that person that allows calls rings at once; the
  first to answer takes the call and the others stop ringing.
- **The server decides whether a call may ring**: consent, one ringing call per
  person, rate limits. iOS Focus and Do Not Disturb apply as to any call.
- **One voice path.** An answered agent call is an ordinary chat voice call with
  one extra opening context entry. There is no second voice stack.

## Flow

1. The agent calls `call_user` with a short `reason` (shown on the ring screen
   and in the chat) and optionally a `recipient`: another workspace member by
   email or name, who must have "Teammates' agents too" on.
2. The server checks consent and limits, creates an `agent_calls` row
   (`ringing`, deadline 40 s), appends `session.agentCall.ringing`, and queues
   one ring per eligible phone through the native push outbox:
   - iOS: an APNs VoIP push (`apns-push-type: voip`, topic `<app id>.voip`,
     expiring at the deadline) to the phone's PushKit token. The ring screen
     shows the reason as the caller; the call handle is the chat, so calling
     back from the Phone app's recents opens that chat.
   - Android: a high-priority FCM data message, expiring at the deadline. It
     carries the call as `opengeniCall` (`type: "ring"`, the same fields as the
     PushKit payload) next to the ordinary "… is calling" notification fields.
     An app built with the config plugin's `call.androidSystemCall` reports
     the ring as a self-managed Telecom call (androidx core-telecom) and shows
     the incoming-call notification (`CallStyle`) with a full-screen ring
     screen over the lock screen; answering opens the app and hands the call
     to the same `incoming` adapter as on iOS. An older app, or one without
     system calls, shows the plain notification instead. The setting shows on
     Android only in an app with system calls and push. While the app runs it
     follows the call's state, as on iOS; a ring that was settled elsewhere
     while the app is not running stops at its deadline.
3. The tool waits while the phone rings, like `session_wait`, and returns the
   outcome directly: `answered`, `declined`, `missed`, or `cancelled` when the
   turn stopped. There is no background sweeper: the waiting tool, or the next
   read of the call, settles a call whose deadline has passed.
4. The app, launched in the background if needed, reports the call to CallKit
   immediately (iOS requires this for every VoIP push) and follows the call's
   state while it rings.
5. Answer: the app claims the call (`POST /v1/workspaces/:ws/agent-calls/:id/answer`).
   The first claim wins; the other phones end with "answered elsewhere". The app
   then starts the chat's realtime voice call. When that voice call starts, the
   server attaches the call this person just answered in this chat and adds a
   context entry telling the voice model it placed the call and why, so it
   greets them and says so.
6. Decline on any phone, the deadline, or the turn stopping ends the ring
   everywhere. The outcome is appended as `session.agentCall.settled`, so the
   chat shows "Called you · Answered / Declined / Missed". A missed call also
   posts a normal notification ("Missed call", with the reason) that opens the
   chat. A declined call needs no notification: the person just declined it.

## Limits

- One ringing call per person at a time.
- At most 3 calls per chat per hour. After a decline, that chat cannot ring the
  same person again for 15 minutes.
- Results state facts only: what happened, what the person now sees (such as
  the missed-call notice), and when a refused call can ring again. Whether to
  call again or notify instead is the agent's judgment; the tool description
  only reminds it that every call interrupts the person, so it weighs urgency
  and whether they asked to be called.

## Storage

- `native_push_devices`: rules `call` and `call_members` (both off unless the
  person turns them on; `call_members` requires `call`), and `voip_token` for
  iOS PushKit. An iOS phone without a PushKit token cannot take calls.
- `agent_calls`: id, workspace, session, callee and caller, caller label,
  reason, state, phones rung, deadline, answering phone, voice call id,
  timestamps. Workspace row-level security, owner-run functions for push.
- Rollout: migration 1107 withheld the runtime's EXECUTE on its owner-run
  functions for one release (runtime posture `DEFERRED_RUNTIME_PRIVATE_ROUTINES`),
  because the previous release rejects a grant on a definer it does not know.
  Migration 1239 grants all six routines to every configured application
  role; readiness now requires them. The current binary uses native push v2
  directly and no longer drops call rules or returns `no_phone` just because
  grants are withheld. The v1 SQL routines and their grants remain intact for
  older binaries during a rolling deploy.
  **Ordering:** 1239 ships after a production release containing 1107
  (commit `d91058a8b8` or later) was pinned in
  `scripts/runtime-posture-baseline.json` by a separate PR (production
  `0f85b681`); a local compatibility run against 1107 is not a production
  release receipt.

## Products embedding Opengeni

A product that embeds Opengeni rings its own app with its own push credentials:

1. Its app asks the person, per phone, whether agents may call it (off by
   default), and keeps the phone's PushKit token in the product's backend.
2. Its backend, acting as the person (`asUser`), states how many of their
   phones it rings: `setAgentCallHostPhones(workspaceId, { phones, teammates })`
   (`PUT /v1/workspaces/:ws/agent-call-phones`, `phones: 0` removes them). The
   row is per person per organization (`1143_agent_call_host_phones`). Agents
   count these phones alongside the person's Opengeni app phones, so `no_phone`
   only means nobody can ring them.
3. The backend subscribes a workspace or organization webhook to
   `session.agentCall.ringing` and `session.agentCall.settled` (organization
   endpoints since `1212_organization_webhook_agent_calls`), and on ringing sends a VoIP push to the
   person's opted-in phones. The event's `devices` counts only the phones
   Opengeni rang itself.
4. The app reports the call to CallKit with the shared React Native package
   (`useIncomingAgentCalls`, `useNativeVoipToken`) and answers or declines
   through `getAgentCall`, `answerAgentCall` and `declineAgentCall`, relayed
   by its backend as the person. Answering then starts the chat's voice call,
   exactly as in the Opengeni app. A missed call posts the usual
   `session.notification.posted`, which the product delivers like any other.

## Testing

CallKit and PushKit do not ring in the iOS Simulator. On Android, the
emulator runs the self-managed call, the ring screen and the call
notification; the FCM ring needs a real Firebase project. The server state machine,
the push dispatch and the app's handling are unit tested; the full ring is
verified on a real phone through TestFlight.
