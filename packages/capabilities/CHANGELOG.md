# @opengeni/capabilities

## 0.3.1

### Patch Changes

- Updated dependencies [16387c3]
  - @opengeni/network@0.2.3

## 0.3.0

### Minor Changes

- f51adf8: Add the reusable first-party local MCP bridge contract and adapter registry,
  and route Gmail's reviewed REST bridge through the generic adapter selection
  seam.

## 0.2.3

### Patch Changes

- b06071c: Publish the Gmail integration visibility fix with product release 0.23.8.

## 0.2.2

### Patch Changes

- a77e804: Publish the Gmail integration visibility fix with product release 0.23.7.

## 0.2.1

### Patch Changes

- a551666: Fix local Gmail provider OAuth callbacks, Google scope equivalence, stable
  Discovery compilation, and installed API integration visibility in session
  tool selection.

## 0.2.0

### Minor Changes

- 1e78f58: Replace provider presets and nullable integration identities with immutable Integration Definitions. Curated and workspace-authored integrations now share one definition-based contract, provenance model, OAuth callback, SDK route, runtime projection, and maintenance migration with no legacy API alias or fallback authority.
- 1e78f58: Make Facet definitions and bindings authoritative throughout the Integration domain. Public routes, SDK methods, Pack components, owner identities, physical tables, persisted manifests, and runtime projections now use one Facet vocabulary with a maintenance cutover and no compatibility aliases.

## 0.1.1

### Patch Changes

- d73a2a9: Ship the package-local Apache license and declare Capabilities route scroll ownership so verified releases pass their source and package contracts.
- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.
