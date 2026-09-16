# MCP connection cutover

MCP execution now uses ordinary native connections, including OAuth access and
refresh credentials. Integrating backends provision connections through the
same connection APIs used by interactive clients, under the canonical actor.
Personal selections remain bound to the named user captured by accepted work.

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