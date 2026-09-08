# Data tools and credentials

## Existing customer APIs can become agent tools

The customer does not need an MCP server when it already has a suitable HTTP or GraphQL API. Choose among these paths:

1. **OpenAPI Integration** — publish a focused OpenAPI 3.0 or 3.1 document for the operations the agent may use. OpenGeni deterministically compiles selected operations into agent tools.
2. **GraphQL Integration** — expose a bounded GraphQL endpoint when that is the product's canonical API shape.
3. **Remote MCP server** — use MCP when the customer wants an agent-oriented protocol, richer discovery, or compatibility with other agent clients.
4. **Narrow gateway** — add a small customer-owned API in front of legacy services, then describe that gateway with OpenAPI or MCP.

The OpenGeni SDK's createSession tools field selects MCP-style runtime capabilities. It does not accept arbitrary JavaScript, Python, Go, or C# callback functions from the customer's backend. Existing backend functions must be reachable through an authorized network API and one of the supported tool surfaces.

An installed API Integration and a remote MCP server are distinct control-plane resources even though both become model-callable tools at runtime. Preserve that distinction when explaining setup, IDs, credential lifecycle, and failures.

Do not create an MCP server merely to rename otherwise safe API endpoints. Do not expose a broad internal API merely because it already exists. Prefer the least new infrastructure that produces a clear, bounded, stable agent contract.

## OpenAPI and GraphQL lifecycle

The normal workspace-scoped API Integration flow is deterministic control-plane work, not a model repeatedly reading and approving documentation:

1. Host the API description and provider endpoint where the OpenGeni control plane can reach them under the deployment's network policy.
2. Create or resolve the appropriate encrypted Connection when authentication is required.
3. Call previewApiIntegration with the source and, when needed, the Connection.
4. Apply the customer's policy to the compiled operation list, safety classification, warnings, and approval modes. Select only intended operations.
5. Call installApiIntegration with the exact preview revision and content digest, Connection, stable instance key, and allowed operations.
6. Persist the returned non-secret instance and server identifiers with the workspace provisioning record, then select that server for sessions.

Preview and install are ordinary backend API calls and can be automated. Human review is required only when the customer's policy or the operation risk requires it. The immutable revision/digest fence ensures that automation cannot install a different schema from the one it evaluated.

Definitions, Connections, and installations are workspace-scoped. A per-user or per-chat workspace strategy may therefore need deterministic installation reconciliation for each workspace. Use a stable provisioning version and skip work that is already at the desired version; do not rediscover and reinstall on every chat request.

An agent-focused API description is often helpful: concise descriptions, stable operation identifiers, bounded schemas, server-side pagination, explicit read/write semantics, and no irrelevant administrative routes. It can describe existing endpoints rather than creating a second implementation.

## MCP lifecycle

A workspace MCP capability is suitable when many sessions in that workspace use the same server and authority. A session may also receive an explicit mcpServers definition with URL, allowed tools, approval policy, and write-only credential headers or a non-secret Connection reference.

For session-specific MCP credentials, createSession stores header values encrypted and returns only metadata such as header names and credential version. Later accepted message requests can rotate those values through the supported MCP credential-update field without recreating the session. For workspace Connections, rotate or reconnect the Connection with optimistic versioning; installed Integrations continue to reference its stable ID.

Prefer short-lived, audience-bound tokens when the customer can issue them. Let the customer's authenticated backend mint or refresh a token for the exact product subject and data boundary. A workspace-wide credential is appropriate only when every session in that workspace may exercise the same provider authority.

## Where credentials are visible

For brokered API Integrations and MCP connections:

- plaintext credentials enter a trusted OpenGeni API boundary and are encrypted at rest under the deployment's configured key;
- API responses, session events, and model-visible tool definitions expose metadata, not the secret value;
- the trusted control plane decrypts the credential only to construct an authorized outbound request to the selected provider destination; and
- the model and sandbox receive the tool schema and bounded tool result, not the credential itself.

This is credential brokerage, not zero-knowledge storage. OpenGeni operators with the deployment encryption authority are in the trusted computing base. A provider could still echo secrets in an unsafe response, so customer endpoints must never return credentials and OpenGeni tool results should remain bounded and reviewed.

Do not put tokens in an OpenAPI document URL, MCP URL, prompt, modelContext, Skill, browser response, or log. Use Connections, write-only MCP headers, a supported OAuth flow, or the customer's secret manager.

## Authorization belongs at every layer

Tool selection is not data authorization. The customer API must validate the presented credential on every operation and derive or verify the allowed tenant, user, report, and row scope. Do not trust model-supplied tenant IDs. Prefer endpoints whose server derives scope from token claims; when an ID is accepted, verify it belongs to those claims.

Separate operations by risk. Read-only analytics, data export, saved-report mutation, and administrative actions should not share an unnecessarily broad token or approval policy. Keep destructive or consequential writes absent or approval-gated unless the customer explicitly wants autonomous writes.

For analytics, return structured, bounded data with clear units, time zones, filters, pagination, and aggregation semantics. Provide server-side aggregates where practical. The agent may combine tool calls or use CodeMode to transform authorized results without placing every intermediate row in conversational context. Code execution happens in the selected OpenGeni sandbox or Connected Machine; provider credentials remain in the broker. Confirm that the installed tool surface is available to CodeMode before relying on that optimization.

## Rotation and failure

Design rotation before launch:

- keep Connection or session-server identifiers as non-secret references;
- update the encrypted credential under optimistic version or idempotency control;
- retry reads only when provider semantics make replay safe;
- never replay a write after an ambiguous provider acceptance;
- surface reauthentication as product state; and
- revoke the old provider credential after the new path is verified.

Test expiry, revocation, insufficient scope, wrong audience, wrong tenant, provider timeout, schema drift, and an ambiguous write outcome. A successful happy-path query does not prove a safe data integration.
