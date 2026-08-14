# @opengeni/capabilities

## 0.2.0

### Minor Changes

- 1e78f58: Replace provider presets and nullable integration identities with immutable Integration Definitions. Curated and workspace-authored integrations now share one definition-based contract, provenance model, OAuth callback, SDK route, runtime projection, and maintenance migration with no legacy API alias or fallback authority.
- 1e78f58: Make Facet definitions and bindings authoritative throughout the Integration domain. Public routes, SDK methods, Pack components, owner identities, physical tables, persisted manifests, and runtime projections now use one Facet vocabulary with a maintenance cutover and no compatibility aliases.

## 0.1.1

### Patch Changes

- d73a2a9: Ship the package-local Apache license and declare Capabilities route scroll ownership so verified releases pass their source and package contracts.
- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.
