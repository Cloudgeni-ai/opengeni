# MCP connection cutover

MCP execution now uses ordinary native connections, including OAuth access and
refresh credentials. Integrating backends provision connections through the
same connection APIs used by interactive clients, under the canonical actor.
Personal selections remain bound to the named user captured by accepted work.

## Attached accounts

An enabled native connector can attach multiple authorized connections, including
workspace-owned connections and the current sender's personal connections. The
public `connectionAccounts` input contains connector/account pairs, not owners,
tokens, or delegation grants. Repeated connector IDs are valid when the account
IDs differ. An explicit set narrows that connector; an omitted set selects its
eligible accounts. The web composer keeps these controls inside Connectors and
blocks an explicit empty selection until an account is attached or the connector
is disabled.

An exact `connectionRef.connectionId` remains pinned to that account, including
custom API instances. Multi-account selectors are unpinned; the explicit
`accountSelection: "all_eligible"` mode cannot be combined with a connection ID,
host authority, or account-specific selected resources. Existing exact
configurations are not silently converted to selectors.
Legacy unpinned selectors retain their existing eligible-account behavior.
New catalog OAuth/API-key enables explicitly select this mode. Reconnects retain
an existing selector or exact pin; adding an account never silently converts an
existing exact installation into a selector.
The dedicated Slack account setup enables a previously disabled stock Slack
capability with this selector after successful account connection. Bot setup and
reconnects of already-enabled capabilities do not rewrite their bindings.

Admission resolves credential-free `mcpAccountBindings`. Each binding retains its
canonical connector ID for policy and a stable account-qualified runtime route
for execution, alongside its exact native connection reference and readable
account label. Personal bindings additionally retain the verified sender;
workspace bindings never acquire a personal owner. The account-qualified routes
are separately visible to tool discovery, so selecting a tool also selects its
account. Missing or revoked accounts do not fall back to another identity.

The accepted binding set follows queued work, continuations, child work and
scheduled occurrences. New empty sets mean no authenticated account routes;
historical absent/null sets retain the legacy execution path. Scheduled tasks
save the selected pairs with `connectionAccountsFrozen: true` under the task's
execution owner and revalidate them when an occurrence is accepted. A frozen
empty list stays empty if accounts are connected later. Material edits preserve
the accepted selection unless the owner explicitly replaces the account choices;
historical tasks without the marker retain their prior selection semantics.
Unavailable selected accounts permanently block the occurrence with
`connection_account_unavailable`, rather than retrying another identity.
Later workspace participants cannot borrow the
prior sender's personal accounts. Results posted in a shared session remain
visible to that session's participants.

Dedicated first-party surfaces, such as personal GitHub repository access and
Google Drive publication, retain their existing specialized selection contracts;
they accept at most one account per specialized surface. Generic MCP account
attachment does not broaden those permissions.

The former host-specific credential callback is removed from API and worker
startup and from the core package. The direct workspace tool gateway also uses
the native connection engine. Host-provenance references are rejected; their
opaque IDs are never treated as native connection IDs.

The host binding/delegation/resolver HTTP routes and corresponding SDK methods
are removed. `OPENGENI_HOST_MCP_CREDENTIAL_RESOLVERS_JSON` no longer configures
the runtime. Do not register a callback or copy a host binding into a native
connection reference. Provision an ordinary connection and select it explicitly.

See [product integration](product-integration.md),
[connection authority](design/connection-authority-delegation.md), and the
[architecture map](architecture.md) for native ownership and execution behavior.

## Native instance registration

This heading is retained for historical deployment links. Migration 0463 and its
corrections are historical schema steps, not instructions to register a resolver
with the current API. Existing migration bytes and historical records are not
rewritten by the runtime cutover.

## Remaining cleanup

Internal host compatibility types and persistence remain pending removal.
The unused host credential broker and its callback-only tests are removed;
native physical-request authorization has its own runtime regression test.
The unused DB registration/resolver adapters and automatic child, causal and
scheduled host-authority capture are also removed. External identity-link
capture remains independent and retains its lifecycle tests. Historical inbox
records still participate in batching comparisons but create no new host
authority. Historical tables and applied migrations are not deleted here.
Public session/task admission no longer captures host selections and rejects
the retired selection field. Remaining internals do not restore the removed
worker or gateway callback execution paths. This is not a claim that every old schema object has already
been removed.

The former host-admission rollout flag is also removed. Host-owned references
are rejected at startup and on capability/session admission; setting the old
environment variable cannot reactivate that execution path.

An external credential supplier may later be supported as an adapter behind the
same connection model. That optional adapter is not implemented by this cutover
and must not recreate a separate registry, ownership or selection framework.