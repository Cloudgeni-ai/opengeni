# Proxy from any backend

`createSessionProxyHandler` is JavaScript. A Django, Rails, Go, PHP or Java
backend does not need a Node sidecar: implement the same small contract in its
own web framework and point the unmodified browser SDK (`OpenGeniClient` with
`baseUrl: "/api/opengeni"`) and `@opengeni/react` at it.

The proxy forwards an **exact allowlist** of routes to the OpenGeni API, adds
the organization key and the signed-in user's identity, and removes everything
the browser must not choose. Anything else is a 404.

## Routes to forward

Paths are relative to the mount (`/api/opengeni`) and to `/v1/` upstream.
`{ws}` must equal the workspace your server resolved for this user; `{sid}` is
any session id (OpenGeni checks the user may read it; add your own check if
your product restricts sessions further).

| Method | Path | Body rules |
| --- | --- | --- |
| GET | `config/client` | In the response: set `apiContractRevision` to the browser's `x-opengeni-api-contract` header value, set `sandboxFiles: false`, and remove `artifacts` |
| GET | `workspaces/{ws}` | |
| GET | `workspaces/{ws}/model-catalog` | |
| GET | `workspaces/{ws}/live-events/stream` | SSE: stream through |
| POST | `workspaces/{ws}/inference-control` | `action` must be `"resume"` |
| POST | `workspaces/{ws}/files/uploads` | only `scope`, `filename`, `contentType`, `sizeBytes`, `sha256` |
| POST | `workspaces/{ws}/files/uploads/{id}/complete` | |
| POST | `workspaces/{ws}/files/{id}/download-url` | |
| GET | `workspaces/{ws}/sessions` | require `view=page`; add `createdByKind=subject&createdBySubjectId=<the user's subjectId>` to list only their chats |
| POST | `workspaces/{ws}/sessions` | browser may send only `initialMessage`, `idempotencyKey`; **your server** adds `agent`, tools, Skills, model |
| GET | `workspaces/{ws}/sessions/{sid}` | |
| PATCH | `workspaces/{ws}/sessions/{sid}` | only `{ "title" }` |
| PUT | `workspaces/{ws}/sessions/{sid}/archive` | only `archived`, `expectedVersion` |
| GET | `workspaces/{ws}/sessions/{sid}/events` | refuse `mode=forensic` |
| GET | `workspaces/{ws}/sessions/{sid}/events/stream` | SSE: forward `Last-Event-ID`, stream through |
| POST | `workspaces/{ws}/sessions/{sid}/events` | `type` must be `user.message`, `user.approvalDecision` or `user.humanInputResponse`; message rules below |
| POST | `workspaces/{ws}/sessions/{sid}/steer` | message rules |
| GET | `workspaces/{ws}/sessions/{sid}/queue` | |
| POST | `workspaces/{ws}/sessions/{sid}/queue/{id}/{move\|edit\|steer\|delete}` | |
| GET, PUT | `workspaces/{ws}/sessions/{sid}/composer-draft` | message rules on PUT |
| POST | `workspaces/{ws}/sessions/{sid}/composer-draft/submit` | message rules |
| POST | `workspaces/{ws}/sessions/{sid}/control` | `action` must be `"pause"` or `"resume"` (never cancel) |
| GET | `workspaces/{ws}/sessions/{sid}/human-input-requests[/{id}]` | |

Message rules (send, steer, draft, submit): reject `mcpCredentialUpdates`;
`resources` may only contain `{ "kind": "file", ... }`; drop `model`,
`reasoningEffort` and `latencyMode` if your product fixes the model. Your server
may add `modelContext` (page state) and `mcpCredentialUpdates` (fresh tool
tokens) before forwarding.

Approval/human-input response rules: reject browser-supplied
`payload.mcpCredentialUpdates` too. Your authenticated backend may add fresh
`payload.mcpCredentialUpdates` before forwarding either response, including
Reject/Skip, but must not add message-only `modelContext`. OpenGeni commits the
encrypted replacements atomically with the accepted response before resume.

Artifact and Site viewing (the JS handler's opt-in `artifacts: true`) is not in
this list: it needs a per-user cache partition in `config/client`, live
tickets, and a session-scope check on every read (`x-opengeni-session-id` plus
`GET /v1/workspaces/{ws}/sessions/{sid}/artifact-associations/{id}`). Leave it
out, and link artifacts to your own authenticated pages with `resolveLink`.

Get the user's `subjectId` once per user from `GET /v1/access/me` with the
headers below, and cache it.

## Headers

Add on every upstream request:

```text
Authorization: Bearer <organization API key>
x-opengeni-external-actor: <percent-encoded JSON>
  {"mode":"external","identity":{"externalId":"<your user id>","source":"<your app>"}}
x-opengeni-api-contract: <copied from the browser's request>
Content-Type: application/json            (requests with a body)
Last-Event-ID: <copied from the browser>  (SSE only)
```

Do not forward anything else from the browser: no `Cookie`, `Authorization`,
or other `x-opengeni-*` headers. Return upstream status codes and JSON error
bodies unchanged; they carry codes the SDK understands.

## Security rules

- Authenticate the product user on **every** request and derive the workspace
  and user id on the server. Never read them from the path, query or body.
- Reject any `{ws}` other than the resolved one (403).
- Keep the allowlist exact: route **and** method. Never forward arbitrary paths
  under the organization key.
- Apply your CSRF protection to POST, PUT and PATCH.
- Bound request bodies (1 MiB is plenty) and do not log bodies or keys.
- Stream SSE without buffering (`text/event-stream`, no compression, flush each
  event) and abort the upstream request when the browser disconnects.
- The user must already be a workspace member (onboarding with
  `addExternalWorkspaceMember`); the proxy never grants membership.

## Django example

```python
# urls.py: path("api/opengeni/<path:rest>", views.opengeni_proxy)
import json, os, re, urllib.parse

import httpx
from django.http import HttpResponse, JsonResponse, StreamingHttpResponse

API = os.environ["OPENGENI_API_BASE_URL"].rstrip("/")
KEY = os.environ["OPENGENI_API_KEY"]
SOURCE = "acme-app"

ROUTES = [  # (method, pattern); {ws} is replaced with the resolved workspace id
    ("GET", r"config/client"),
    ("GET", r"workspaces/{ws}(/model-catalog|/live-events/stream)?"),
    ("POST", r"workspaces/{ws}/(inference-control|files/uploads(/[^/]+/complete)?|files/[^/]+/download-url)"),
    ("GET", r"workspaces/{ws}/sessions"),
    ("POST", r"workspaces/{ws}/sessions"),
    ("GET", r"workspaces/{ws}/sessions/[^/]+(/events(/stream)?|/queue|/composer-draft|/human-input-requests(/[^/]+)?)?"),
    ("PATCH", r"workspaces/{ws}/sessions/[^/]+"),
    ("PUT", r"workspaces/{ws}/sessions/[^/]+/(archive|composer-draft)"),
    ("POST", r"workspaces/{ws}/sessions/[^/]+/(events|steer|control|composer-draft/submit|queue/[^/]+/(move|edit|steer|delete))"),
]

def upstream_headers(request, user_id):
    actor = {"mode": "external", "identity": {"externalId": user_id, "source": SOURCE}}
    headers = {
        "Authorization": f"Bearer {KEY}",
        "x-opengeni-external-actor": urllib.parse.quote(json.dumps(actor), safe=""),
        "Content-Type": "application/json",
    }
    for name in ("x-opengeni-api-contract", "Last-Event-ID"):
        if name in request.headers:
            headers[name] = request.headers[name]
    return headers

def opengeni_proxy(request, rest):
    user = request.user  # your auth; CsrfViewMiddleware covers POST/PUT/PATCH
    if not user.is_authenticated:
        return JsonResponse({"error": {"code": "unauthorized"}}, status=401)
    ws = user.profile.opengeni_workspace_id  # resolved on the server, never from the request
    path = rest.removeprefix("v1/")
    if not any(m == request.method and re.fullmatch(p.replace("{ws}", re.escape(ws)), path)
               for m, p in ROUTES):
        return JsonResponse({"error": {"code": "route_not_allowed"}}, status=404)
    body = request.body if request.method != "GET" else None
    if body and len(body) > 1_048_576:
        return JsonResponse({"error": {"code": "body_too_large"}}, status=413)
    # Apply the body rules from the table here (create fields, message rules,
    # control actions, event types), build the full session request for
    # POST .../sessions, and add the creator filter to the session list.
    headers = upstream_headers(request, str(user.id))
    url = f"{API}/v1/{path}"
    if path.endswith("/stream"):
        client = httpx.Client(timeout=None)
        upstream = client.send(
            client.build_request("GET", url, headers=headers, params=request.GET), stream=True)
        response = StreamingHttpResponse(upstream.iter_raw(), status=upstream.status_code,
                                         content_type="text/event-stream")
        response["Cache-Control"] = "no-store"
        response["X-Accel-Buffering"] = "no"
        return response
    upstream = httpx.request(request.method, url, headers=headers, params=request.GET,
                             content=body, timeout=60)
    if path == "config/client" and upstream.status_code == 200:
        # The browser speaks its own SDK's contract; an OpenGeni deploy must not look stale.
        config = upstream.json()
        config["apiContractRevision"] = request.headers.get(
            "x-opengeni-api-contract", config["apiContractRevision"])
        config["sandboxFiles"] = False  # sandbox-path reads are not proxied
        config.pop("artifacts", None)  # upstream capabilities never cover this proxy
        return JsonResponse(config)
    return HttpResponse(upstream.content, status=upstream.status_code,
                        content_type=upstream.headers.get("content-type", "application/json"))
```

Run it with an ASGI or threaded server so open event streams do not block other
requests. The `ROUTES` patterns cover the allowlist; the body rules in the table
still need their few lines of checks.
