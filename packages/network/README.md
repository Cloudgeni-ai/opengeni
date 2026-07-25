# `@opengeni/network`

`@opengeni/network` is the low-level outbound transport used by OpenGeni's
credential-bearing MCP and OAuth paths. It resolves a destination hostname once,
rejects private and special-use answers unless the caller has explicitly enabled
the local/test or private-target escape, and supplies the vetted address through a
per-request Undici 6.x `Agent` lookup. TLS hostname verification remains enabled:
the URL hostname is still the TLS identity and is never replaced with an IP or
used with `rejectUnauthorized: false`.

The response body owns the dispatcher lifecycle. The per-request agent is closed
after a body completes and destroyed after cancellation, stream failure, or a
fetch failure. This keeps long-lived MCP SSE streams alive while preventing a
completed or abandoned response from retaining a socket pool.

Callers must put credential-resolution wrappers *outside* the pinned transport:

```ts
const guarded = (input: string | URL, init?: RequestInit) =>
  pinnedFetch(input, init, settings, { fetchImpl: undiciFetch });
const withCredentials = resolveHeadersThenCall(guarded);
```

The wrapper must add `Authorization`, API-key, or OAuth form credentials before
calling `pinnedFetch`; the policy resolution and pinned Agent are the final
network boundary. Callers must not preflight with one fetch and then call a
second global fetch.

The package uses Undici's fetch implementation from its explicit
`undici/index.js` entrypoint for production callers. Bun's bare `undici`
specifier resolves to a compatibility shim whose `Agent` does not expose the
dispatcher methods needed by `fetch`, and Bun's native `fetch` does not provide a
portable guarantee that an Undici `dispatcher` is honored. Bun callers should use
the exported transport (or the explicit Undici entrypoint) rather than
substituting Bun's native fetch after the guard. This package does not follow
redirects; each caller must make a manual redirect decision and call the transport
again so every hop is independently resolved and pinned.