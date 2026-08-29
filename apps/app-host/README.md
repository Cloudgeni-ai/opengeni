# OpenGeni app host

This standalone Bun process serves authorized immutable Apps release bytes from
a dedicated origin. It owns HTTP validation, strict response headers, exact
range streaming, and the narrow resolver callout; it does not own Apps
lifecycle, persistence, release key derivation, or tool execution.

See [`../../docs/apps.md`](../../docs/apps.md) for the canonical request,
deployment, provider, and operator contract.
