# 11. The same guest network everywhere, firewalled per sandbox

Status: Accepted, 2026-10-16; amended 2026-10-20 (listed destinations and
the sandboxes' name server replace the `trusted` switch; queries to
unreachable name servers are answered by the sandbox's own)

## Context

A restored guest keeps its old address, routes and gateway entry. If they
differ on the new host, its network breaks until something repairs it.
Sandboxes run untrusted code next to each other and next to the host.

## Decision

- Every guest has the same address (169.254.0.21), MAC and gateway, and every
  tap the same MAC. A sandbox's identity on the host is its namespace's uplink
  address, which the namespace translates the guest to.
- Each sandbox has its own network namespace and firewall. The internet is
  allowed. The host, private, shared, link-local (including the cloud metadata
  address), loopback, multicast and reserved ranges, and other sandboxes are
  not. Spoofed addresses and ARP claims are dropped.
- A host may list exact destinations beyond the internet, each a name, an
  address or a range with the TCP ports guests may open there (`--reach`).
  Each opens just those ports, in the same firewalls; nothing always
  blocked (the metadata address, loopback, the link pool) can be listed.
  This replaced an earlier all-or-nothing `trusted` switch that opened the
  whole local network, which on a host joined to an overlay network or a
  home network gave every sandbox everything the host could reach.
- Every guest's name server is its gateway, 169.254.0.22, on every host.
  The host answers there inside each namespace: a listed name with the
  addresses the firewalls open for it, anything else by asking public name
  servers (`--dns`). The host's own name server, which on a private
  network knows every private name, is never asked for a guest. Names are
  resolved when the agent starts, so what guests are told and what the
  firewalls open always agree; a name that moves takes effect at the next
  agent start, which leaves sandboxes running (ADR 9).
- A query to port 53 of an address the guest may not reach is sent to its
  own name server, which answers in that address's place. A guest booted
  under an older host that named a private name server (an overlay's, a
  cloud's), or an image that names one, keeps resolving after it is
  restored behind these rules, and learns no more than any other guest.
  Queries to name servers it may reach, public ones or a listed
  destination, go where they were sent.
- The rules are enforced twice: inside the namespace, which the VMM joins
  without the privilege to change it, and again on the host.
- After a restore, when the guest runs a notice handler on the configured
  port, the agent tries to tell it the current time and that connections it
  opened before are gone, before anything else uses it. A failed notice is
  logged; the guest's own clock sync is the fallback.

## Consequences

- A restored guest's network configuration is right on any host; nothing is
  repaired after restore. Open connections do not survive. Its name server
  is the same address everywhere, so a guest restored from a template, after
  a move or on a host with other upstream name servers still resolves.
- A guest booted under an older host keeps the name servers it was told
  until it next boots: public ones it asks directly, private ones are
  answered by its own name server, so it resolves either way.
- Guest ports relay bytes and add no identity: every sandbox's forwarded
  connections reach their upstream from the host's address. The upstream
  authenticates each one by a credential only that sandbox holds, never by
  address or an id the guest states.
- Setting up a namespace takes a few milliseconds at create, nothing at wake.
