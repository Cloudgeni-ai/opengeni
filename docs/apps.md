# Apps: immutable origin hosting

OpenGeni Apps are frozen release files served from a dedicated origin by the
standalone `apps/app-host` process. The app host is a byte plane, not an Apps
control plane: it has no database connection, user session, deployment access
key, model credentials, browser credentials, or authority to list storage.

This document is the canonical home for the Apps origin request contract,
operator configuration, and serving restrictions. App lifecycle, release, and
tool-call APIs remain owned by their contracts and control-plane adapters.

## Request and authority model

A launch URL has this form:

```text
https://<dedicated-app-host>/.opengeni/launch/<opaque-token>/[release-relative-path]
```

The token stays in the path because the Apps origin does not use cookies. The
host rejects requests carrying `Cookie`, `Authorization`, or
`Proxy-Authorization`, hashes the token immediately, and sends only the digest
to its resolver. `Referrer-Policy: no-referrer` prevents the launch URL from
being emitted as a browser referrer.

For every GET or HEAD, the host:

1. validates and normalizes the HTTP `Host` and release-relative path;
2. calls the resolver with the host, token digest, and normalized requested
   path;
3. receives either no grant or exact immutable object keys selected from the
   frozen release manifest;
4. performs an object HEAD, then streams only conditional byte ranges pinned
   to the returned provider generation/ETag; and
5. fails closed if the object disappears, changes generation, truncates a
   range, or the resolver/storage backend fails.

Missing paths are resolved as missing before storage access. The host never
lists a bucket, probes a derived prefix, accepts a caller-provided object key,
or constructs a key from a URL path. It also rejects a resolver result unless
the App id is the exact leftmost label of the normalized request Host and every
selected object key is a canonical digest-addressed frozen build-file key for
that same App. A staging, source, manifest, cross-App, or arbitrary raw key is
never eligible for serving.

## Resolver interface

The process uses a narrow authenticated HTTP callout. Its default in-cluster
location is the API service path
`/internal/apps/resolve-launch`; the control-plane integration must implement
that route and authenticate `x-opengeni-app-host-resolver-key` with a dedicated
shared secret.

Input:

```ts
type AppLaunchResolveInput = {
  host: string;
  launchTokenDigest: `sha256:${string}`;
  requestedPath: string | null;
};
```

Successful output:

```ts
type AppLaunchResolution = {
  appId: string;
  releaseId: string;
  launchId: string;
  previewId: string | null;
  publicationId: string | null;
  expiresAt: string;
  spaFallback: boolean;
  requestedObject: { path: string; objectKey: string } | null;
  entryObject: { path: string; objectKey: string };
};
```

Exactly one of `previewId` and `publicationId` must be non-null. The resolver
must use database time for expiry/revocation checks, resolve the requested path
from the already-frozen manifest, and return `404` for a denied or absent
launch. If the database stores the token hash as raw hexadecimal, the adapter
must remove the transport-only `sha256:` prefix before lookup.

Object identities must originate from the canonical Apps helpers in
`@opengeni/core`, including `appBuildObjectKey`; the app host deliberately does
not duplicate that tenant-aware derivation and never receives a workspace id.
The resolver response is bounded to 16 KiB and has a two-second default
deadline.

## HTTP behavior

The origin supports GET, HEAD, and one RFC-style byte range. Multiple or
unsatisfiable ranges return `416`; valid ranges return `206`. An `If-Range`
request is conservatively served as a complete `200` response instead of
trusting a browser validator that is unrelated to the storage generation.

SPA fallback is allowed only when the frozen launch enables it and the request
is a browser navigation (`Sec-Fetch-Mode: navigate` or an HTML `Accept` value).
Other missing assets return `404` without touching object storage.

Responses include a restrictive CSP, denied Permissions Policy, `nosniff`,
same-origin resource policy, HSTS, no-referrer, and private no-store/no-transform
cache policy. The default CSP permits scripts, styles, and workers only from the
dedicated Apps origin, sets `connect-src 'none'`, and denies forms, objects,
child frames, and framing unless an operator explicitly configures approved
frame ancestors. Governed tool calls therefore cross only the reviewed parent
window bridge; app code cannot connect directly to the control-plane API. The
origin emits neither cookies nor credentialed CORS headers.

Health endpoints report process health only. `/healthz` and `/readyz` do not
probe the resolver or object-storage provider, so upstream failures surface as
generic `503 origin_unavailable` responses without provider, token, or key
diagnostics.

## Release URL requirements

The host never rewrites frozen HTML, CSS, JavaScript, manifests, or source maps.
Apps must preserve the launch-token path prefix themselves:

- use relative asset URLs; absolute URLs such as `/assets/app.js` intentionally
  omit the launch capability and return `404`;
- prefer hash routing for SPAs, or use a reviewed prefix-aware router that does
  not replace `/.opengeni/launch/<token>/`;
- do not assume a cookie, bearer token, query parameter, service worker outside
  the launch prefix, or parent-origin credential; and
- use parent-window messaging through the reviewed Apps SDK for governed tool
  calls rather than opening the control-plane API from app code.

These rules are release-readiness requirements. A bundle that only works after
the origin mutates its bytes is not launchable.

## Helm deployment

The chart keeps `appHost.enabled=false` by default. A typical dedicated-origin
overlay is:

```yaml
appHost:
  enabled: true
  frameAncestors:
    - https://console.example.com
  ingress:
    enabled: true
    host: "*.apps.example.com"
    tls:
      - secretName: apps-example-com-tls
        hosts:
          - "*.apps.example.com"
```

Provision wildcard DNS and TLS separately, then configure the Apps control
plane with a matching dedicated HTTPS origin template such as
`https://{appId}.apps.example.com`. Do not reuse the web/API hostname. The
App id must be the complete leftmost hostname label. The Ingress must preserve
the original Host and Range headers and must not inject ambient authentication,
rewrite paths, compress responses, or transform immutable response bodies.

The selected credentials Secret must contain
`OPENGENI_APP_HOST_RESOLVER_KEY` and any storage credentials required by the
provider. `appHost.credentialsSecret` may select a dedicated Secret; only the
named keys are projected, never the complete Secret. Rotate the resolver key
on both the API adapter and app-host pods as one deployment operation.

Prometheus metrics use a separate internal listener (`appHost.metricsPort`,
default `9090`). The app-host ServiceMonitor and optional chart collector scrape
that named port; the public Apps Ingress targets only `appHost.service.port`.
When NetworkPolicy is enabled, configure `networkPolicy.monitoring` for an
external Prometheus namespace/pod selector. The chart admits its own optional
collector explicitly. Do not add a public ingress route for `/metrics`.

App-host HTTP metrics deliberately collapse launch URLs to the fixed route
label `/.opengeni/launch/:token/:path` and non-contract paths to `/other`.
Labels never contain an App id, workspace id, launch token or digest, hostname,
release-relative path, object key, provider version, or error text.

When NetworkPolicy egress isolation is enabled, the chart allows the in-chart
API and selected Garage/MinIO fixture. Operators must add
`networkPolicy.egress.rules` for cluster DNS, an external resolver URL, or
provider object-storage endpoints.

## Object-storage permissions and providers

The app-host identity needs read-only object metadata and ranged object reads
for frozen Apps build keys. Deny list, write, overwrite, multipart upload,
delete, and access to staging/source objects. Scope the provider policy to the
Apps frozen-build namespace whenever the provider supports prefix conditions.
Signed browser PUTs target staging keys only. Finalization verifies those bytes,
copies them create-only to digest-addressed frozen keys, and verifies the frozen
copy before publication. Replaying an earlier signed PUT can replace staging
bytes but cannot change the frozen key selected by a launch manifest or the
bytes the app host serves.

Current driver behavior:

| Backend | Conditional read identity | Credential dependency |
| --- | --- | --- |
| S3-compatible | ETag with `If-Match` | Access key and secret key are required. |
| AWS S3 | ETag with `If-Match` | Workload identity or optional static keys. |
| Azure Blob | ETag with `ifMatch` | Connection string, or account name plus account key; workload identity is not implemented by the current storage driver. |
| Google Cloud Storage | Object generation | Ambient workload identity or JSON credentials. The chart does not mount a key file. |

All backends must return a stable non-empty version token for HEAD and enforce
that exact identity on every requested range. The process refuses to start if
the selected storage adapter lacks raw HEAD plus conditional-range support.

## Operator acceptance

Before enabling public traffic, verify:

- one hostname maps to one stable App origin and the wildcard certificate is
  valid;
- an expired or revoked launch returns `404` based on database time;
- a missing asset causes no storage request and a missing SPA navigation reads
  only the entry object;
- GET, HEAD, suffix ranges, open-ended ranges, and `416` behavior survive the
  ingress unchanged;
- changing an object generation between HEAD and range terminates the response;
- cookies and authorization headers are rejected;
- a request on the web/API hostname and a resolver result for another App are
  rejected before object storage is touched;
- replaying a signed staging PUT after finalization does not change bytes served
  from the frozen launch key;
- the app-host ServiceMonitor is healthy on the internal metrics port while the
  public Apps origin does not expose `/metrics`;
- the app-host pod has no database, model, browser, deployment-access, or broad
  runtime Secret environment; and
- storage IAM cannot list, write, overwrite, or delete objects.
