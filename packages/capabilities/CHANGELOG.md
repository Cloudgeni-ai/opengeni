# @opengeni/capabilities

## 0.3.4

### Patch Changes

- 084e56b: Apply the curated source size limit consistently when parsing Microsoft's Graph definition while preserving the smaller limit for custom sources. Keep OneDrive file and sharing operations within the tool limit by excluding the nested Excel workbook API.
- 37f16c2: Keep curated Microsoft Graph integrations within storage and MCP schema limits by explicitly exposing provider-validated JSON bodies instead of expanding the recursive entity graph. Preserve request parameters, body requirements, media types, authorization and write approvals. Reject oversized compiled revisions during preview before installation begins.

  Request People.Read for the signed-in user's people suggestions. Keep OneDrive to file scopes and omit the organization-only followed-sites surface, allowing personal Microsoft accounts to complete consent.

## 0.3.3

### Patch Changes

- Updated dependencies [52cf486]
- Updated dependencies [92cdc31]
  - @opengeni/network@0.3.1

## 0.3.2

### Patch Changes

- Updated dependencies [876396d]
  - @opengeni/network@0.3.0

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
