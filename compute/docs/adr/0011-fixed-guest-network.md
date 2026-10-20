# 11. The same guest network everywhere, firewalled per sandbox

Status: Accepted, 2026-10-16

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
- A host marked `trusted` also lets guests reach its local network.
- The rules are enforced twice: inside the namespace, which the VMM joins
  without the privilege to change it, and again on the host.
- After a restore, when the guest runs a notice handler on the configured
  port, the agent tries to tell it the current time and that connections it
  opened before are gone, before anything else uses it. A failed notice is
  logged; the guest's own clock sync is the fallback.

## Consequences

- A restored guest's network configuration is right on any host; nothing is
  repaired after restore. Open connections do not survive.
- Guest ports relay bytes and add no identity: every sandbox's forwarded
  connections reach their upstream from the host's address. The upstream
  authenticates each one by a credential only that sandbox holds, never by
  address or an id the guest states.
- Setting up a namespace takes a few milliseconds at create, nothing at wake.
