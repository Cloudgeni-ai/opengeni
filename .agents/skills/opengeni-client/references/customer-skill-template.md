---
name: customer-opengeni-integration
description: >-
  Use when editing or verifying this product's server-side OpenGeni adapter,
  tenant-to-workspace mapping, session proxy, or integration smoke tests.
---

# Customer OpenGeni integration

Replace every bracketed placeholder with a non-secret project fact. Keep this
Skill beside the product's integration code and review it whenever the installed
`@opengeni/sdk` major version changes.

## Stable configuration

- OpenGeni base URL: `[non-secret HTTPS base URL]`
- Organization ID: `[non-secret UUID]`
- External source convention: `[stable product namespace, for example acme-support]`
- Credential environment variable: `OPENGENI_ORGANIZATION_API_KEY`
- Base URL environment variable: `OPENGENI_API_BASE_URL`
- Organization environment variable: `OPENGENI_ORGANIZATION_ID`

Never put API keys, delegated signing secrets, provider tokens, production
responses, or user identifiers in this Skill. Read credentials from the
server-side secret manager or environment at runtime.

## Chosen integration shape

This product uses `[organization API key | workspace API key | delegated token]`
because `[one sentence explaining the authority boundary]`.

- Server-side adapter/proxy: `[path]`
- Tenant-to-workspace mapping persistence: `[path or table/model name]`
- Session/event proxy: `[path]`
- Product Skill store/loader: `[path]`

If the selected shape is an organization API key, map one authenticated product
tenant to one OpenGeni organization workspace with `ensureWorkspace`. The wire
kind is `"shared"`. Personal workspaces are excluded and must never be used as
a default fallback. Persist the returned opaque workspace ID and pass the exact
product-selected Skills inline in `CreateSessionRequest.skills` for every
product-created session; there is no organization-wide Skill inheritance.
Use a key issued by the organization API-key control plane. Do not reuse an
ambiguous legacy null-workspace token; provenance migrations revoke those keys
so old and new API instances both fail closed during rollout.

If the selected shape is a workspace API key, configure one pre-provisioned
workspace ID and never call `ensureWorkspace` or an organization API-key route.
The credential is valid only for that exact workspace. If the selected shape is
a delegated token, use only the account/workspace and permissions frozen into
the host-issued token; do not substitute organization-key behavior.

## Required workflow

1. Authenticate the product user and resolve the allowed product tenant.
2. Load the server-held credential; never return it to the browser.
3. For an organization key, resolve or ensure the tenant's workspace with the
   stable external source/id pair. For a workspace key, load and verify the
   configured pre-provisioned workspace ID instead.
4. Apply explicit workspace settings through installed SDK methods.
5. Create sessions with a stable idempotency key and product-owned inline
   Skills.
6. Reject caller-supplied workspace/session IDs that do not match the product's
   persisted tenant relationship.
7. Proxy event streaming with replay-by-sequence and duplicate suppression.

## Smoke probes

Run through the product's authenticated server-side test harness; do not paste
credentials into shell history or this file.

```text
GET /v1/config/client
GET /v1/access/me
GET /v1/workspaces
```

Verify that the live deployment and installed SDK types agree. They outrank
remembered route, model, provider, tool, or compute lists. For an organization
key, an empty `workspaceGrants` array in `/v1/access/me` is expected;
`GET /v1/workspaces` is the complete organization-workspace inventory.