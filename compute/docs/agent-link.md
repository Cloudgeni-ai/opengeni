# The agent link: how Opengeni reaches the agent in a sandbox

[ADR 21](adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md)
decides the design; this is the contract between its three parts:

- the **guest**: `compute-guest` and `opengeni-agent` in fabric mode;
- the **host**: `compute-host`, which speaks NATS to its guests and keeps
  one link to each Opengeni deployment its sandboxes belong to;
- the **gateway**: Opengeni's endpoint for those links, which bridges each
  sandbox's session to Opengeni's NATS as the agent itself would.

```text
 opengeni-agent ──NATS──▶ 127.0.0.1:3958 ─vsock 58─▶ compute-host ══ link (WSS) ══▶ gateway ──NATS──▶ worker, API
   (in the guest,           (compute-guest            one session per sandbox,        (Opengeni API)
    no credential)           forwards)                 one link per host
```

Version 1. Every part rejects what it does not understand rather than
guessing.

## 1. What a create carries

Opengeni creates a sandbox with the native API (`POST /v1/sandboxes`,
`X-API-Key`):

```json
{
  "request_id": "a caller-chosen id, 1 to 128 of [A-Za-z0-9._:-]",
  "image": "opengeni-sandbox", "vcpus": 2, "memory_mib": 4096,
  "sleep": null, "metadata": {"opengeni.lease": "..."},
  "init": {
    "env_vars": {"KEY": "value"},
    "default_user": "root", "default_workdir": "/workspace",
    "agent": {
      "workspace_id": "the enrollment's workspace",
      "agent_id": "the enrollment's agent id",
      "workspace_root": "/workspace",
      "desktop": false
    }
  }
}
```

- `request_id` makes the create idempotent for the team: the same id with
  the same body, `init` included, answers the same sandbox, woken if it
  sleeps, and gives its guest the init again; with any other body,
  `409 request_mismatch`; after that sandbox was deleted, `410 request_gone`.
  A `504` or a lost answer is retried with the same id. The service forgets
  a request id seven days after its sandbox is deleted.
- The answer, `201` for the first create and for each replay, is the
  sandbox's view once its guest has kept the init. The view names the agent
  as `"agent": {"workspace": "...", "agent": "..."}`; it never shows the
  ticket.
- `init.agent` holds no secret. The relay's address and token come from the
  gateway (section 4).
- A sandbox with an `agent` needs its team to have a gateway in the fleet's
  configuration (section 4); otherwise the create is `400 invalid`.
  `workspace_id` and `agent_id` are 1 to 64 of `[A-Za-z0-9_-]`.
- Errors are `{"code": "...", "message": "..."}`:

  | Status | `code` | What to do |
  |---|---|---|
  | 400 | `invalid` | Fix the request. |
  | 401, 403 | `unauthorized`, `forbidden` | Fix the API key. |
  | 404 | `not_found` | It does not exist (or is already gone, for a delete). |
  | 409 | `busy` | Another operation holds it; retry. |
  | 409 | `request_mismatch` | Use a new `request_id`. |
  | 410 | `request_gone` | Its sandbox was deleted; use a new `request_id`. |
  | 502 | `host`, `init_failed` | The host or the guest refused; retry with the same id, or delete. |
  | 503 | `no_capacity`, `unavailable` | Retry later with the same id. |
  | 504 | `unknown_outcome` | Retry with the same id. |
  | 500 | `internal` | Retry with the same id. |
- `POST /v1/sandboxes/{id}/wake` wakes and, for a sandbox with no owner,
  places and adopts it; it answers `{"waited_us", "generation", "host"}`
  once it runs. `DELETE /v1/sandboxes/{id}` ends it; `404` means it is
  already gone.
- `GET /v1/requests/{request_id}` answers the view of the sandbox that
  request made, `404 not_found` if no create named it, or `410 request_gone`
  once that sandbox was deleted, so a caller that crashed between a create
  and recording its answer can find the sandbox and delete it, without
  creating one.
- The API serves TLS when the fleet service is given a certificate
  (`--api-tls-cert`, `--api-tls-key`); a deployment that Opengeni reaches
  over a network it does not own must.

## 2. In the guest

- `compute-guest` keeps the init on the sandbox's disk before it answers,
  then, when it has an `agent` section and `/usr/local/bin/opengeni-agent`
  exists, writes `/run/compute/agent/link.json` (root only):

  ```json
  {"workspace_id": "...", "agent_id": "...", "workspace_root": "/workspace",
   "nats_url": "nats://127.0.0.1:3958"}
  ```

  and starts `opengeni-agent run --fabric /run/compute/agent/link.json`
  (with `--virtual-desktop` when `desktop` is true). It restarts the agent
  after it exits, with back-off.
- It listens on `127.0.0.1:3958` and forwards each connection to the host,
  vsock CID 2, port 58, byte for byte. The port is not NATS's own 4222, so
  a NATS server the sandbox's user runs, as when developing Opengeni
  itself, keeps that port. It listens only once the sandbox runs an agent.
- An image without envd works too: the guest then answers notices and
  inits itself, and is ready at boot.
- The agent subscribes to `_compute.relay` and keeps the latest relay
  credential it receives there (section 3) in memory, for the streams it
  opens.
- After each restore notice it sends the agent `SIGUSR1`: the agent drops
  its NATS connection and dials again at once.
- The agent registers activity as files `/run/compute/activity/<label>.<pid>`
  holding a decimal count; the guest adds the counts of files whose pid is
  alive to its answer to the host's `activity` question. The guest empties
  the directory when it boots.

## 3. Host and guest

The host answers each connection on a sandbox's vsock port 58 as a NATS
server would, for the subset the agent's client uses:

- It sends `INFO` first, with `headers: true`, `auth_required: false`,
  `proto: 1` and the gateway's `max_payload`.
- It reads `CONNECT`; `name` must be `opengeni-agent/connection/<instance>`.
  The instance is the agent process's connection instance id.
- `PING` gets `PONG`. `SUB`, `UNSUB`, `PUB` and `HPUB` map onto the
  sandbox's session (section 5); messages come back as `MSG` or `HMSG`. With
  `verbose`, each accepted operation gets `+OK`.
- A subject outside the session's permissions gets
  `-ERR 'Permissions Violation for Publish to "<subject>"'` (or `Subscription`),
  as from a real server, and the connection stays open.
- `_compute.relay` is the host's own subject: a subscription to it never
  reaches the gateway. The host sends the session's relay credential on it,
  as a `MSG` whose payload is `{"url": "...", "token": "...", "expires_at_ms": ...}`,
  as soon as both the subscription and a credential exist, and again for
  each fresh credential.

## 4. The link

- The host dials `GET <gateway>` as a WebSocket over TLS, with
  `Authorization: Bearer <host token>` and the subprotocol
  `opengeni.agent-link.v1`. A team's gateway URL is the fleet service's
  configuration (`--team-link <team>=wss://...`, with the signing key in
  `--link-key` and keys being retired in `--link-previous-key`), never part
  of a create.
- Each WebSocket binary message is one frame: a JSON header, one `\n`
  byte, then the payload bytes (empty unless the frame carries a message).
  Text messages are a protocol error.
- Either side pings every 20 seconds and closes a link silent for 60.
- The host dials again with full-jitter back-off from 100 ms to 10 s, and
  on each new link opens its sessions again.

### Tokens

Both are JWTs (`alg` `EdDSA`, `typ` `JWT`, `kid` naming the key) signed by
the fleet service. Opengeni reads the keys, and its own team, from
`GET /v1/link/keys` with its API key:
`{"team": "...", "keys": [{"kty": "OKP", "crv": "Ed25519", "kid": "...", "x": "<base64url>"}]}`,
cached five minutes and read again for an unknown `kid`.

- **Host token**, valid for an hour, which the host asks the fleet for over
  its mutual-TLS host API, `POST /v1/hosts/link-tokens` with
  `{"name": "<host name>", "gateways": ["wss://..."]}`, answering
  `{"tokens": [{"gateway", "token", "expires_at_ms"}]}` in the same order,
  and asks for again when a third of its life is left:
  `{"typ": "compute-host", "iss", "aud": "<gateway URL>", "sub": "<host name>", "iat", "exp"}`.
  The fleet signs only for the name in the host's client certificate and
  only for gateways its teams name; anything else is `403`.
- **Sandbox ticket**, given to the host with each create or adopt, valid
  for that owner epoch. It has no time in it, so the same placement always
  gives the same ticket and a retried create stays identical:
  `{"typ": "compute-sandbox", "iss", "aud", "sub": "<sandbox id>", "host": "<host name>",
  "epoch": 3, "team", "workspace": "<workspace id>", "agent": "<agent id>"}`.
  Each hand-off and each adopt raises the epoch, so a move from one host to
  another gives the new host a ticket two epochs on. Deleting the sandbox
  revokes its enrollment, which ends what the ticket allows.

The gateway accepts a link only for a valid host token whose `aud` is its
own URL, allowing 60 seconds of clock skew.

### Frames, host to gateway

| `t` | Fields | Meaning |
|---|---|---|
| `open` | `s`, `sandbox`, `ticket`, `connection` | Open session `s` (a number the host never reuses on this link) for a sandbox, with its ticket and the agent's connection instance. |
| `sub` | `s`, `sid`, `subject`, `queue`? | Subscribe; `sid` is the host's, stable for the session. |
| `unsub` | `s`, `sid` | Unsubscribe. |
| `pub` | `s`, `subject`, `reply`?, `headers`? | Publish the payload. `headers` is a list of `[name, value]`. |
| `state` | `s`, `state` | `awake` or `asleep`, for display only. |
| `close` | `s` | End the session: the sandbox left this host or its agent process changed. |

### Frames, gateway to host

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `version`, `max_payload` | First frame on a link. |
| `opened` | `s`, `scope`, `relay` | The session is open; `scope` is `agent.<workspace>.<agent>.connection.<instance>`; `relay` is `{url, token, expires_at_ms}`. |
| `refused` | `s`, `code`, `message` | Not opened: `invalid_ticket`, `stale_epoch`, `unknown_agent`, `revoked`, `duplicate` (another live instance holds the agent) or `unavailable` (try again later). |
| `msg` | `s`, `sid`, `subject`, `reply`?, `headers`? | A message for a subscription, with the payload. |
| `relay` | `s`, `url`, `token`, `expires_at_ms` | A fresh relay credential, sent before the last one expires. |
| `closed` | `s`, `code`, `message` | The gateway ended the session: `revoked`, `superseded` (a later epoch opened) or `lost` (its claim lapsed). |
| `error` | `s`, `code`, `message`, `sid`? | An operation was refused (`permission`, `too_large`); the session stays open. |

Until `opened`, the host keeps what the guest sends for the session.

## 5. Sessions

- **Permissions.** As the NATS callout grants an agent: subscribe within
  `<scope>.>`; publish within `<scope>.>` or `_INBOX.>`. The gateway
  enforces them; the host checks them too, to answer the guest at once.
- **Opening.** The gateway checks the ticket (signature, `typ`, `aud`,
  `host` equal to the link's host, `team` equal to Opengeni's), finds the
  active enrollment of kind `sandbox` for `workspace` and `agent`, checks the
  epoch against the highest it recorded for that agent (lower: `stale_epoch`;
  higher: record it and end any other session for the agent), and claims the
  connection instance as the callout does. It then subscribes for the
  session through its own NATS connection.
- **Liveness.** While a session is open the gateway renews the claim's
  lease, every five seconds, whether or not the sandbox runs; a renewal that
  finds a later epoch or another instance ends the session with `closed`.
- **Sleep.** The host keeps a session open while its sandbox sleeps. A
  `msg` for a sandbox that is not running wakes it and waits, in order, until
  the agent has subscribed again to the subject, for up to 120 s; if the
  sandbox does not come back by then they are dropped, and Opengeni's
  request times out. A guest that reconnects with the same instance takes up
  the same session and subscriptions; with another instance, the host closes
  the old session and opens a new one.
- **Records.** The host keeps each sandbox's instance and subscriptions in
  its record, and opens those sessions again when it starts or its link comes
  back, before any guest runs.
- **Ending.** The host closes a session when it hands off or removes the
  sandbox. Revoking the enrollment, when the sandbox is deleted, makes the
  gateway end it with `revoked`.

What the host does, exactly (`compute-link`, its `core` module):

- **Connected means reachable.** A guest connection gets `INFO` only once
  its gateway's link is up, and the `PONG` for the agent's first `PING`
  only once its session is open, so a client that counts itself connected
  is reachable end to end. What the agent sends before that waits, in
  order, up to 4 MiB; beyond it the connection ends with `Slow Consumer`.
- **A link that goes ends its guests' connections,** as a NATS server that
  goes would, so each agent reconnects to a session that opens again on the
  next link. The host dials again with full-jitter back-off from 100 ms to
  10 s, back to the shortest after a link that stayed up 30 s.
- **Messages wait for 120 s.** A message for a subscription no connection
  holds waits that long for the agent to subscribe again, and wakes the
  sandbox at most every 250 ms. Messages that arrive count as activity;
  what the agent sends does not.
- **Subscriptions not taken up within 10 s end.** After the agent
  reconnects, the host unsubscribes those it did not subscribe to again.
- **Refusals.** `duplicate` and `unavailable` are retried with jittered
  back-off from 1 s doubling to 30 s; any other refusal, and `closed` with
  `revoked` or `superseded`, shuts the agent out until the fleet gives the
  sandbox a new ticket. `closed` with `lost` opens the session again.
- **The host token is checked when a link opens.** A token that expires
  later does not end the link; the host fetches a fresh one when less than
  a third of its life is left and presents it on its next dial.
- **A host that hangs up** sends every frame it queued before its `close`.

## 6. When no one answers

A message to an agent whose sandbox has no session (its host was lost, or
it was handed off and not yet adopted) gets "no responders". Opengeni's
compute backend then calls `POST /v1/sandboxes/{id}/wake` and retries the
request under its replay identity until the agent answers or the request's
deadline passes.
