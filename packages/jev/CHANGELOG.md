# @opengeni/jev

## 0.1.1

### Patch Changes

- 6146167: `code_search` never searches or returns platform credential material. `.opengeni/` (Codemode tokens, Git credential files and bindings), `.azure/` (the Azure CLI login cache) and `.config/opengeni/` (Connected Machine enrollment credentials) are excluded at any depth from every ripgrep call, and an explicit path into one of them, in any spelling or through a symlink, is ignored.

## 0.1.0 - initial

- Native TypeSafe Jev client (chunking within the request limits, bounded retries, abort, typed errors) and an in-process circuit breaker.
- The `code_search` engine, a port of the validated scout-0.3.1 research tool behind an injected workspace interface, plus its model-facing tool surface.
