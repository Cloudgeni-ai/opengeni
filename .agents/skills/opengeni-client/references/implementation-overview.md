---
name: opengeni-product-integration
description: Design, implement, verify, and hand off a tenant-safe OpenGeni product integration while adapting to the customer's architecture, UI, data APIs, and desired delivery autonomy. Select only for an implementation session; installation alone does not expose it to other agents.
---

# OpenGeni product integration

Use this Skill to add OpenGeni capabilities to an external product. It guides the coding or implementation agent. Pack installation keeps it inactive; explicitly select it only for the implementation session. Do not attach it to customer-facing runtime sessions.

The desired outcome is a native-feeling product experience backed by a standalone OpenGeni deployment, with the product retaining authority over its users, tenants, business data, and UI. Adapt to the customer's system instead of imposing a sample architecture, framework, cloud, release process, or chat design.

## Operating stance

- Start from the user's outcome and the existing system. Inspect repository guidance, authentication, tenancy, data access, frontend conventions, installed packages, tests, CI, and deployment documentation before proposing a shape.
- Prefer current evidence from the installed OpenGeni SDK types, the live client configuration, and the live access/capability responses. Do not make an ordinary customer integration depend on reading the OpenGeni source repository.
- Ask only for consequential product choices or authority that cannot be inferred safely. Do not ask for facts the repository, deployment configuration, or existing product behavior can answer.
- When an unknown choice is reversible and low-risk, choose the best-fitting default, state the assumption, and continue. When it changes privacy, tenant authority, write access, cost exposure, or an external mutation, resolve it before crossing that boundary.
- Possession of a credential or access to a cloud, repository, or deployment is technical capability, not authorization. Match the user's requested delivery autonomy and the repository's stated workflow.
- Keep alternatives open until evidence eliminates them. Use strict rules only for actual security, privacy, protocol, or authorization invariants.

Read the references selectively:

- For discovery, question selection, and delivery autonomy, read [Discovery and autonomy](references/discovery-and-autonomy.md).
- Before choosing a workspace mapping, session visibility, or tool policy, read [Isolation and authorization](references/isolation-and-authorization.md).
- When choosing stock UI, SDK, React, Svelte, mobile, or a custom experience, read [Product shapes and UI](references/product-shapes-and-ui.md).
- When exposing customer APIs or handling MCP, OpenAPI, GraphQL, credentials, or CodeMode, read [Data tools and credentials](references/data-tools-and-credentials.md).
- When choosing model behavior, generating the customer-specific runtime profile, provisioning, testing, or handing off, read [Runtime profile and verification](references/runtime-profile-and-verification.md).

## Non-negotiable boundaries

- Keep organization API keys and provider credentials on trusted servers. Never put them in browser or mobile bundles, prompts, Skill files, model context, logs, or ordinary tool results.
- The customer backend authenticates its own user and derives the allowed OpenGeni workspace and session. A browser-provided OpenGeni workspace or session ID is never authorization.
- Choose a workspace for the smallest group that is allowed to share workspace-scoped agent authority and resources. Turning workspace Memory off does not isolate conversations.
- Organization-key-created top-level sessions are workspace-visible. Do not present managed-human Only-me session visibility as a service-backend privacy mechanism.
- Same-workspace agent isolation based on removing cross-session tools is defense in depth, not a hard tenant boundary. Use separate workspaces when the requirement is a hard boundary.
- For a headless customer-facing agent, set an explicit minimal tool policy. Omitting the first-party tool selection inherits defaults, which can include cross-session and workspace-wide capabilities.
- The OpenGeni client cannot turn arbitrary in-process customer backend functions into remote agent tools. Expose existing APIs through a reviewed OpenAPI or GraphQL Integration, or provide an MCP server.
- Credentials brokered by OpenGeni are encrypted at rest and excluded from model-visible schemas and results, but the trusted OpenGeni control plane can decrypt them to make the authorized provider request. Do not claim that OpenGeni never possesses them.

## What the implementation must resolve

Resolve these from evidence and customer intent, in whatever order the system makes efficient:

- the product experience and how much agent activity it exposes;
- the collaboration or privacy unit that maps to an OpenGeni workspace;
- the backend authentication and opaque product-to-OpenGeni mapping;
- the data/tool path and the authority enforced by the customer API;
- the model, reasoning, instructions, Skills, memory, approvals, and tool policy for the customer-facing agent;
- the provisioning, update, credential-rotation, observability, and deletion lifecycle; and
- the requested implementation, review, deployment, and handoff boundary.

Do not turn this list into a mandatory questionnaire. Infer first, ask only what remains material, and continue with safe work while choices that do not block it remain open.

## Completion standard

An integration is not complete merely because one chat returned an answer. Verify tenant isolation, authenticated routing, idempotent provisioning and session creation, credential containment and rotation, explicit tool selection, event recovery, failure presentation, framework-native UI behavior, and the agreed delivery workflow. Leave the customer with concise operational knowledge and a customer-specific runtime profile without attaching this generic implementation Skill to runtime chats.
