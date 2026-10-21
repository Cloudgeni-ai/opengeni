---
"@opengeni/runtime": patch
---

Stop trusting the compromised emSign root certificates in every runtime Opengeni ships. In October 2026 the private keys of eight eMudhra intermediate CAs chaining to emSign roots became recoverable, so anyone on the network path could impersonate any HTTPS host to a client that still trusts those roots. Bun and Node trust a root list compiled into their executables regardless of the operating system store, and Bun 1.4.3 and Node 22.22.0 still include all four emSign roots. Image builds now rewrite those four certificates inside the shipped Bun and Node binaries (and verify the compiled browser controller and artifact materializer) so no chain can reach them, while every other root keeps working. The Rust agent and relay move to webpki-roots 1.0.10, which drops emSign ECC Root CA - G3.
