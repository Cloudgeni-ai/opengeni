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
lifecycle. A model call to an `approval: human` entry is rejected by the gateway
unless the attempt host confirms the exact model name and subject from its
approved SDK invocation context; model-supplied arguments or transport metadata
cannot grant that authority. A Site version's requested identities are only a
host-filtered maximum allowlist. Publishing grants no tool authority; the API
revalidates the active version and the viewer's live authority before using the
ordinary gateway approval and execution path. The
external/current-human MCP adapter has no
server-verifiable one-shot approval exchange, so it projects only entries whose
classification is not `human`; a direct call to a hidden projected name is
rejected instead of advertising a tool that can never execute.

`prepareCall` performs catalog, identity, approval, input-schema, and
authorization checks without invoking the supplied executor. Attempt transports
use that seam before crossing their durable side-effect marker, then invoke the
returned execution closure. Ordinary `call` remains the compatible
combined preflight-plus-execution API.

Argument validation enforces the entry's advertised input schema, including
`required`, for every caller. A rejected call throws
`ToolGatewayInputValidationError` (`code: "invalid_tool_arguments"`) before
authorization, lifecycle preparation, or execution. Its `issues` name each
missing, mistyped, or unexpected property by path, for example
`missing required property "context"`, capped at
`TOOL_GATEWAY_INPUT_ISSUES_MAX` with `omittedIssueCount` for the rest; `summary`
and `message` carry the same text. Issues are built from the property path and
the schema only and never quote argument values. The accept/reject decision uses
a validator that stops at the first error, so a schema's own bounds keep
limiting validation cost; a second, all-errors pass runs only after a rejection
and only for arguments up to `TOOL_GATEWAY_INPUT_DIAGNOSTIC_MAX_CHARS`
serialized characters. Larger arguments report the first problem alone. The
all-errors pass also never runs a `pattern` on a string that already exceeds the
same subschema's `maxLength`, so it evaluates no pattern the accept/reject
validator would not.
