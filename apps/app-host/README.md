# OpenGeni app host

This standalone Bun process serves authorized immutable Apps release bytes from
a dedicated origin. It owns HTTP validation, strict response headers, exact
range streaming, and the narrow resolver callout; it does not own Apps
lifecycle, persistence, release key derivation, or tool execution.

The public byte listener defaults to port `8080`. Prometheus exposition runs on
a separate internal listener, port `9090` by default, so an Apps ingress never
publishes `/metrics`. Request metrics use only fixed route/method values and
status codes; App, workspace, launch-token, host, path, and object identities
are excluded from labels.

See [`../../docs/apps.md`](../../docs/apps.md) for the canonical request,
deployment, provider, and operator contract.
