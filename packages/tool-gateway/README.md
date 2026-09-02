# `@opengeni/tool-gateway`

Protocol-neutral catalog validation, authorization, and execution for OpenGeni
tools. Runtime composition supplies already-admitted first-party and integration
definitions; this package gives model MCP, Codemode, HTTP/SDK, external MCP, and
Site adapters one canonical identity and execution path.

The package owns:

- deterministic catalog digests that exclude non-authoritative timestamps;
- exact `{ serverId, toolName }` identities and collision-safe projected names;
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
human approval and every publisher-controlled Site call use a server-issued,
hash-only, single-use capability; Site capabilities are additionally bound to
the exact immutable Site version. Agent attempts keep their existing durable
approval and operation lifecycle. The gateway receives only the resulting
trusted transport metadata. The external/current-human MCP adapter has no
server-verifiable one-shot approval exchange, so it projects only entries whose
classification is not `human`; a direct call to a hidden projected name is
rejected instead of advertising a tool that can never execute.