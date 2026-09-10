# Runtime profile and verification

## Generate customer-specific runtime behavior

This Pack teaches the implementation agent. Installation keeps its Skill inactive until one session explicitly selects it. The implementation agent should derive the customer-facing agent's runtime profile from the customer's product intent and system, then store that profile with the customer's integration code or configuration. Do not attach this generic implementation Skill to end-user runtime chats.

A runtime profile may contain:

- stable workspace instructions or persona;
- one session role and its instructions;
- selected, versioned runtime Skills;
- model and reasoning defaults or per-session overrides;
- exact first-party tools, MCP or API Integration servers, and resources;
- memory, approvals, human-input, and autonomy behavior;
- product context mapping; and
- the event projection the frontend renders.

Use only the pieces the product needs. A simple chat may need concise session instructions and one data Integration, not a new Skill hierarchy.

## Put behavior in the right lifetime

| Concern | OpenGeni surface | Update behavior |
| --- | --- | --- |
| Stable behavior for every session in one workspace | Workspace agent instructions | Reconciled as workspace configuration |
| One agent role or one conversation's system behavior | Session instructions | Fixed for that session |
| Conditional procedure, domain method, or tool-use guidance | Runtime Skill | Installed at workspace scope or sent inline at create |
| Current route, selected dashboard, filters, or viewport | modelContext on the exact message | Updated per accepted message when relevant |
| User-visible request | Initial or follow-up message text | Durable conversation content |
| Default model and reasoning | Workspace session defaults | Applies to newly created sessions |
| Exact model or reasoning for one session or turn | Session create or message options | Explicit request wins, subject to policy |
| Models a workspace may use | Workspace model access policy | Hard allowlist, managed separately |
| Default tool catalog | Workspace session tool defaults | Applies when a create request omits a selection |
| Customer-facing headless tool set | Explicit session tool selections | Fixed onto session; follow-up policy changes use supported session controls |

Do not duplicate the same instruction across workspace instructions, session instructions, Skills, and every user message. Keep stable policy out of modelContext, and keep volatile dashboard state out of the persistent instruction prefix.

Inline Skills are sent once in createSession and stored with that session; they are not retransmitted on every turn. Existing sessions retain their selected Skill content. To update behavior, version the customer profile and use the new Skill definitions for new sessions, with an explicit migration or new-session policy if old conversations must change. Workspace-installed Skills are resolved through their own installation lifecycle and should not also be copied inline.

Model IDs and provider availability are deployment facts. Inspect the live client configuration and model policy. Use workspace session defaults when many sessions share the same choice; use a per-session model or reasoning override when the product or user chooses. Never hard-code a remembered catalog into a reusable integration.

OpenGeni credits are held and admitted at the organization account, so organization workspaces using the OpenGeni-credits model path draw from the same account balance. Workspace count does not create separate credit wallets. Connected subscriptions and workspace-owned provider credentials can use their separately reported external billing path instead. Preserve workspace and product-boundary identifiers in usage attribution so a shared organization balance does not obscure who consumed it.

## Provision and reconcile deliberately

Separate hot-path chat handling from control-plane setup:

- Workspace ensure is idempotent and may run lazily, but persist the result and avoid name-based lookup.
- Apply workspace settings, tool defaults, Connections, API Integrations, and profile versions through a versioned reconciliation step at provisioning, startup, deployment, or a controlled migration.
- Do not patch the same workspace settings, preview the same API, or reinstall the same Integration on every message unless drift was detected.
- Use stable idempotency keys for workspace/session creation and external mutations that support them.
- Store non-secret mapping metadata: product boundary ID, OpenGeni workspace ID, runtime profile version, Integration instance/server ID, Connection ID, and relevant optimistic versions.
- Define lifecycle handling for user disablement, tenant deletion, credential revocation, retention, and workspace cleanup.

For a large existing customer population, choose lazy creation, a bounded backfill, or both. New product users can trigger the same idempotent provisioning path through the customer's normal lifecycle event. Do not require an OpenGeni human signup per product end user for service-backed sessions.

## Verification matrix

Adapt tests to the product, but cover the behaviors that can fail across the boundary:

**Contract and configuration**

- installed SDK types agree with the deployed service and client configuration;
- desired model, reasoning, sandbox, capabilities, and API Integration server exist;
- the intended OpenGeni-credit or externally billed model path is visible and attributed to the product boundary;
- workspace settings and runtime profile reconciliation are idempotent; and
- session creation retries converge on one session.

**Identity and isolation**

- product authentication is required for every proxy route;
- product boundary IDs map to the intended distinct or shared workspaces;
- cross-user and cross-tenant workspace/session ID substitution fails;
- effective first-party and external tool policies contain only intended capabilities; and
- provider endpoints enforce token tenant/user scope independently of prompts.

**Session experience**

- initial and follow-up messages reach the correct session;
- SSE reconnect backfills by sequence without duplicated UI effects;
- unknown additive events do not crash the client;
- the chosen final-only, progress, or detailed projection behaves as intended;
- approvals, human input, cancellation, failures, credit limits, and reconnection are actionable; and
- accessibility and narrow/wide layouts match the host product.

**Data and credentials**

- happy-path tools return bounded structured data;
- expired, revoked, wrong-scope, wrong-audience, and wrong-tenant credentials fail closed;
- credential values do not appear in responses, events, logs, Skills, prompts, or browser bundles;
- rotation succeeds without recreating unrelated state; and
- unsafe or ambiguous writes are not replayed.

Run the existing product test and build commands appropriate to the changed layers. Do not demand a live deployment test when the user retained deployment authority; provide the exact smoke test they can run instead. Do not deploy merely to make local tests pass.

## Handoff

Report the implemented shape in product language:

- what experience was added;
- what product identity maps to a workspace and why;
- where the organization key and provider credentials live;
- how customer data becomes tools and how those tools authorize requests;
- which runtime profile version, model, Skills, memory, approvals, and tools are selected;
- what was tested, including negative isolation tests;
- what was not executed because it remains customer-owned; and
- exact remaining setup, review, deployment, monitoring, or rollback steps.

If a durable customer integration Skill would reduce future rediscovery, generate one beside the integration code containing only stable, non-secret project facts and smoke probes. Do not turn the generic OpenGeni Pack into the customer's analytics prompt, and do not make generated runtime behavior depend on the implementation workspace retaining this Pack forever.
