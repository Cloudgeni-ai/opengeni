# Feedback

Feedback is retained separately from session history, events, and Memory. It never
adds a user message, wakes an agent, or changes session activity. The API supports
general product comments and positive/negative session ratings, optionally tied to
an exact logical turn for later investigation.

## API and SDK

`POST /v1/workspaces/:workspaceId/feedback` accepts:

```json
{
  "idempotencyKey": "1f12cb25-1db1-4e20-9432-02ab7281f539",
  "sessionId": "f134b9f7-da13-45dd-96e1-46bffac59149",
  "sentiment": "negative",
  "comment": "The requested file was not created."
}
```

Use `client.createFeedback(workspaceId, request)` in `@opengeni/sdk`. General
feedback omits `sessionId`, `turnId`, and `sentiment` and requires a nonblank
comment. Session feedback requires either a rating or a nonblank comment. An
optional `turnId` must belong to that exact session. Comments are at most 4,000
JavaScript string code units and are retained exactly, including whitespace.

The response is `{ feedback, replayed }`: 201 for a new submission, 200 for an
identical retry. Preserve the UUID idempotency key and payload when retrying after
a timeout. Reusing a key with different content returns 409. A new key creates a
new immutable submission, preserving earlier ratings instead of overwriting them.
Analytics must distinguish submissions from the newest rating per author/target.

### Context and screenshots

A report can say where it came from and show what the person saw. `context`
carries app and device facts: `source` (`web`, `desktop` or `mobile`) is
required; `trigger` (`menu` or `shake`), `platform`, `appVersion`,
`buildNumber`, `osVersion`, `deviceModel`, `screen` (the app path in view),
`locale`, `timeZone`, `online` and up to ten `recentErrors` (`at`, `message`,
optional `title`, `code`, `status`, `screen`) are optional. `screenshots` holds up
to three JPEG or PNG images as `{ contentType, base64 }`, each at most 3 MiB once
decoded; the server checks each image's signature against its declared type.

Screenshot bytes go to the deployment's object storage under create-only,
content-addressed keys before the row is written, so a retry stores nothing new.
The stored feedback lists `screenshots` as `{ index, contentType, sizeBytes,
sha256 }`; a retry with different images under the same key returns 409.
Submitting screenshots requires object storage (503 without it). The author reads
an image with `GET /v1/workspaces/:workspaceId/feedback/:feedbackId/screenshots/:index`.

The phone app sends this from **Shake to send feedback**: shaking opens a sheet
with a screenshot of the screen in view (removable), a comment and a summary of
the context it attaches. Reports are written to the device first and retried on
launch, on return to the app and every minute until the server accepts them, so a
report is not lost without a connection. Settings has a toggle to turn shaking off.

`GET /v1/workspaces/:workspaceId/feedback` returns `{ feedback: [...] }` containing
only the authenticated principal's general feedback, newest first. Pass
`?sessionId=<uuid>` to read that principal's feedback for an authorized session.
`includeTurns=false` restricts a session list to session-level submissions, as used
by the web rating indicator. `limit` is 1-100 (default 50); this is a bounded recent list, not a full export.
The SDK equivalent is `client.listOwnFeedback(workspaceId, { sessionId, limit })`.

The web sidebar offers **Send feedback**. Completed assistant messages show
thumbs up/down beside Copy and the timestamp on hover, keyboard focus, or touch.
The optional-comment form submits the selected reply's exact turn. Messages from
the same turn share the current rating. The route loads the viewer's recent
ratings once; it does not fetch separately for every message.

## Authority and analysis

Reading requires `workspace:read`. All submissions additionally require the
write-capable `sessions:create` permission, including general comments; read-only
credentials cannot append feedback. A session reference also
requires `sessions:read`, the normal private-session boundary, and the embedding
host's authorization (`session.feedback.write` for submission, `session.read`
for reads). Workspace membership does not grant access to a private session.
Agent attempts cannot submit feedback. API keys and other supported authenticated
product callers retain their own principal identity; they cannot supply another
user's author or a recording timestamp.

The database assigns IDs and timestamps. `feedback_submissions` is FORCE-RLS,
with author, workspace/account, and session-visibility checks, and validates the
turn/session relationship. Runtime privileges are SELECT and INSERT only.
There is no cross-user feedback listing or agent tool. Authorized deployment
operators can investigate retained feedback through their separate database
access and join `session_id`/`turn_id` to session evidence. Feedback grants no new
access to the referenced conversation. Workspace/session/turn deletion cascades
to associated submissions; it is not an indefinite audit archive.

## Deployment

Migration `0425_feedback_submissions.sql` adds to the exact runtime table and
privilege contract. Stop old API, control-worker, and turn-worker processes,
apply the migration, run `db:provision-roles`, and start the feedback-aware
runtime. Do not restart a pre-migration binary after the schema change. No
production deployment is implied by adding the feature to source.
