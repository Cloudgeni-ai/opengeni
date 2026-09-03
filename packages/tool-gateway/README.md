# `@opengeni/tool-gateway`

Protocol-neutral catalog validation, authorization, and execution for OpenGeni
tools. Runtime composition supplies already-admitted first-party and integration
definitions; this package gives model MCP, Codemode, HTTP/SDK, external MCP, and
Site adapters one canonical identity and execution path.

The package owns:

- deterministic catalog digests that exclude non-authoritative timestamps;
- exact `{ serverId, toolName }` identities, normalized exact-name
  disambiguation, and catalog-time rejection of namespace/tool prefix
  collisions;
- bounded catalog, JSON Schema input/output validation, and generated SDK
  declarations;
- caller-aware authorization and approval classification; and
- result-shape preservation around the supplied executor closures.

It does not discover providers, resolve credentials, persist attempt lifecycle,
or mint authority. Those responsibilities remain in runtime and transport
adapters. A catalog digest or friendly name never grants access by itself.

```ts
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";

const { catalog, gateway } = createWorkspaceToolGateway({
  accountId,
  workspaceId,
  generation,
  definitions,
  authorize,
  requireApproval,
});

const result = await gateway.call({
  operationId: crypto.randomUUID(),
  catalogDigest: catalog.digest,
  identity: { serverId: "docs", toolName: "search" },
  arguments: { query: "roadmap" },
  caller: { kind: "http", subjectId },
});
```

Approval evidence is transport-owned. Current-human HTTP calls classified for
human approval use a server-issued, hash-only, single-use capability. The
capability binds the public catalog identity and arguments plus a private
provider-authority digest, so changing an Integration instance, revision, or
connection invalidates an older approval without changing the public catalog.
Connection-backed approval issuance first resolves credentials in a preflight
mode that neither refreshes tokens nor records provider usage; a provider adapter
without that side-effect-free preflight is omitted from the current-human
catalog. Agent attempts keep their existing durable approval and operation
lifecycle. Sites do not use per-call approval: the active immutable version's
requested identities are a host-filtered direct-call allowlist, and the API
revalidates that version and the viewer's live authority before passing trusted
transport metadata to the gateway. Agent-authored versions may retain only
`approval: none` identities from their exact attempt catalog; a current human
must publish a version that activates another approval class. The
external/current-human MCP adapter has no
server-verifiable one-shot approval exchange, so it projects only entries whose
classification is not `human`; a direct call to a hidden projected name is
rejected instead of advertising a tool that can never execute.

`prepareCall` performs catalog, identity, approval, input-schema, and
authorization checks without invoking the supplied executor. Attempt transports
use that seam before crossing their durable side-effect marker, then invoke the
returned execution closure. Ordinary `call` remains the compatible
combined preflight-plus-execution API.