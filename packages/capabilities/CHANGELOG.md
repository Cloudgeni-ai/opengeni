# @opengeni/capabilities

## 5.4.2

### Minor Changes

- 801743c: A connected MCP server's own icon now shows as its connector logo. When a workspace connects or enables its own (custom) MCP server, Opengeni reads the `icons` the server lists in its `initialize` reply (`serverInfo.icons`, MCP 2025-11-25), picks the best one for a single tile (theme-neutral before light or dark, vector before a large raster, favicons last), and stores it as the item's logo. Icons go through the same checks as vendored catalog logos (an image type the asset route serves, at most 512 KB, no scripts or external references in SVGs), are fetched through the deployment's outbound network policy with a timeout and at most three redirects, and are served from `/v1/catalog-assets/...`, so the browser never loads them from the server's host. A server without a usable icon keeps its monogram and connects as before. Tool steps from such a server also find the logo by the server's host. Editing a custom catalog item no longer clears its logo. New `@opengeni/capabilities` exports: `mcpServerIcons`, `rankMcpServerIcons`, `decodeDataUriIcon`, `validateLogoAsset`, `catalogAssetObjectKey` and the other logo-asset checks previously private to the catalog scripts; new `@opengeni/db` export `setWorkspaceCapabilityCatalogItemLogo`.

### Patch Changes

- Updated dependencies [931325b]
- Updated dependencies [a57cfa8]
- Updated dependencies [4488c59]
- Updated dependencies [5a48fe7]
- Updated dependencies [3ee89da]
- Updated dependencies [f6298be]
- Updated dependencies [58d272f]
- Updated dependencies [01188c9]
- Updated dependencies [995c16f]
- Updated dependencies [53e1fe5]
- Updated dependencies [de7087a]
- Updated dependencies [cb15454]
- Updated dependencies [57cfc37]
- Updated dependencies [96502c5]
- Updated dependencies [5f332c1]
- Updated dependencies [24b71c6]
- Updated dependencies [54c2f9e]
- Updated dependencies [936d9e0]
  - @opengeni/contracts@5.4.0
  - @opengeni/network@5.4.0

## 5.3.1

### Minor Changes

- 119f33d: Add independently gated Microsoft Teams agent tools and linked Teams conversations, with durable admission and delivery, private-message authority checks, and workspace setup APIs. Both integrations remain disabled by default.

### Patch Changes

- 5c4cf54: Gmail search, thread and draft-list results now reach the model as compact mail cards (sender, recipients, date, subject, labels, attachment names and the start of the body, with `contentTruncated` when cut), sized to the current model's tool-output budget, so a 50-message full-content search is about 47 KB of model-visible text instead of a 3.5 MB result that had to spill to a file. `get_message` stays complete but drops the HTML body when a plain-text body exists, and replaces an HTML-only body that does not fit the budget with its readable text. Codemode and the spill file still receive the exact results. Local MCP bridges can supply such a model-only copy through the new optional `projectModelToolResult` hook. Cards keep a Reply-To that names another address than the sender. A spilled tool result that arrives before the turn's lazy sandbox has started now starts it and copies the file, so its receipt gives the shell path instead of `null`; the path is given only once the copy is really there.
- Updated dependencies [c8ddf55]
- Updated dependencies [1988e97]
- Updated dependencies [e7f5d38]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
- Updated dependencies [ce72530]
- Updated dependencies [4c6bf32]
- Updated dependencies [f3d19a2]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [9f6cab2]
- Updated dependencies [6f6c356]
- Updated dependencies [d502ba3]
- Updated dependencies [cccd692]
- Updated dependencies [3fa5c6e]
- Updated dependencies [d6c7c4a]
- Updated dependencies [392db50]
- Updated dependencies [31bca3c]
- Updated dependencies [6acfbd3]
- Updated dependencies [21e7ecf]
- Updated dependencies [627b2f1]
- Updated dependencies [c307566]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [f9f0607]
- Updated dependencies [cc319f3]
- Updated dependencies [3b1d8c1]
- Updated dependencies [7d419e2]
- Updated dependencies [e5446f1]
- Updated dependencies [83682c3]
- Updated dependencies [a9809ee]
- Updated dependencies [acac580]
- Updated dependencies [f3d19a2]
- Updated dependencies [31c3308]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0
  - @opengeni/network@5.3.0

## 5.2.1

### Patch Changes

- Updated dependencies [fb72b9d]
  - @opengeni/contracts@5.2.0
  - @opengeni/network@5.2.0

## 5.1.2

### Patch Changes

- @opengeni/contracts@5.1.0
- @opengeni/network@5.1.0

## 5.0.2

### Patch Changes

- Updated dependencies [487bd43]
- Updated dependencies [a9d20b3]
- Updated dependencies [6d29c01]
- Updated dependencies [217ed52]
  - @opengeni/contracts@5.0.0
  - @opengeni/network@5.0.0

## 4.8.0

### Patch Changes

- Updated dependencies [85fb89e]
  - @opengeni/contracts@4.8.0
  - @opengeni/network@4.8.0

## 4.7.2

### Patch Changes

- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
  - @opengeni/contracts@4.7.2
  - @opengeni/network@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/contracts@4.7.1
- @opengeni/network@4.7.1

## 4.7.0

### Patch Changes

- Updated dependencies [31095f1]
  - @opengeni/contracts@4.7.0
  - @opengeni/network@4.7.0

## 4.6.1

### Patch Changes

- @opengeni/contracts@4.6.0
- @opengeni/network@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [f838cb7]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
  - @opengeni/contracts@4.5.0
  - @opengeni/network@4.5.0

## 4.4.1

### Patch Changes

- Updated dependencies [e697879]
- Updated dependencies [11e56da]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [81a516c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [84b1a18]
  - @opengeni/contracts@4.4.0
  - @opengeni/network@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
- Updated dependencies [d1de8b4]
- Updated dependencies [2963eca]
- Updated dependencies [374dd81]
- Updated dependencies [91329fc]
- Updated dependencies [46a2ef3]
- Updated dependencies [579239a]
- Updated dependencies [ffe09c2]
- Updated dependencies [1b57d74]
- Updated dependencies [277c99c]
- Updated dependencies [b20c9b2]
- Updated dependencies [70f0522]
- Updated dependencies [23fed2a]
- Updated dependencies [e4915c1]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [724b529]
- Updated dependencies [3915617]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [b95784c]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/contracts@4.3.0
  - @opengeni/network@4.3.0

## 4.2.0

### Patch Changes

- Updated dependencies [641e179]
- Updated dependencies [e018445]
- Updated dependencies [5715a3e]
- Updated dependencies [47eeb80]
  - @opengeni/contracts@4.2.0
  - @opengeni/network@4.2.0

## 4.1.3

### Patch Changes

- @opengeni/contracts@4.1.2
- @opengeni/network@4.1.2

## 4.1.1

### Patch Changes

- Updated dependencies [afff3f9]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/contracts@4.1.0
  - @opengeni/network@4.1.0

## 4.0.4

### Patch Changes

- Updated dependencies [e7113e3]
- Updated dependencies [35dcfa0]
- Updated dependencies [2f6b8bd]
- Updated dependencies [9482fe0]
- Updated dependencies [2a81601]
- Updated dependencies [b1b51e2]
- Updated dependencies [71dfe30]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [79ec9fd]
- Updated dependencies [1d24639]
- Updated dependencies [a34aebb]
- Updated dependencies [5927aae]
- Updated dependencies [6ab7b55]
- Updated dependencies [3e061d6]
- Updated dependencies [a22ed79]
  - @opengeni/contracts@4.0.0
  - @opengeni/network@4.0.0

## 3.4.0

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/contracts@3.4.0
  - @opengeni/network@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/contracts@3.3.0
  - @opengeni/network@3.3.0

## 3.2.2

### Patch Changes

- Updated dependencies [a0c35a1]
  - @opengeni/contracts@3.2.0
  - @opengeni/network@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies [17d61c6]
- Updated dependencies [1e67711]
- Updated dependencies [0bdb953]
- Updated dependencies [79af429]
- Updated dependencies [877c70d]
  - @opengeni/contracts@3.1.0
  - @opengeni/network@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [501bb83]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
- Updated dependencies [d367818]
  - @opengeni/contracts@3.0.0
  - @opengeni/network@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [2ea5f7b]
  - @opengeni/contracts@2.0.1
  - @opengeni/network@2.0.1

## 2.0.0

### Patch Changes

- Updated dependencies [fc57bd2]
- Updated dependencies [04ebc42]
- Updated dependencies [e03f1ff]
- Updated dependencies [c2f4153]
- Updated dependencies [de2d721]
- Updated dependencies [055015d]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [6861501]
- Updated dependencies [bfed4f1]
- Updated dependencies [4532435]
- Updated dependencies [f96605f]
- Updated dependencies [496ce55]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [ce7b403]
- Updated dependencies [445baf4]
- Updated dependencies [5b4a738]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [f7d53b2]
- Updated dependencies [c13d080]
- Updated dependencies [061ae01]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [6313dd8]
- Updated dependencies [945490f]
- Updated dependencies [8e878ac]
- Updated dependencies [9701372]
- Updated dependencies [bc40348]
- Updated dependencies [5eb1c32]
- Updated dependencies [da01634]
- Updated dependencies [ab3306a]
- Updated dependencies [4cb80a9]
- Updated dependencies [eb68b58]
- Updated dependencies [38b1ba1]
- Updated dependencies [6960770]
- Updated dependencies [3426850]
- Updated dependencies [412671a]
- Updated dependencies [63bf721]
- Updated dependencies [3a4a435]
- Updated dependencies [14343e4]
- Updated dependencies [2b8ee21]
- Updated dependencies [71c42bf]
- Updated dependencies [a390b9e]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [322f26c]
- Updated dependencies [945c247]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [5cb6d71]
- Updated dependencies [732a788]
- Updated dependencies [8cf9e0a]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [7ce535f]
- Updated dependencies [35fb6fd]
- Updated dependencies [35fb6fd]
- Updated dependencies [7bf1a02]
- Updated dependencies [a13bf1a]
- Updated dependencies [a91718c]
  - @opengeni/contracts@2.0.0
  - @opengeni/network@2.0.0

## 1.4.4

### Patch Changes

- Updated dependencies [6384dbd]
  - @opengeni/contracts@1.4.4
  - @opengeni/network@1.4.4

## 1.4.3

### Patch Changes

- @opengeni/contracts@1.4.3
- @opengeni/network@1.4.3

## 1.4.2

### Patch Changes

- @opengeni/contracts@1.4.2
- @opengeni/network@1.4.2

## 1.4.1

### Patch Changes

- Updated dependencies [9145bad]
- Updated dependencies [f290348]
  - @opengeni/contracts@1.4.1
  - @opengeni/network@1.4.1

## 1.4.0

### Patch Changes

- Updated dependencies [bd9521c]
- Updated dependencies [08ce841]
- Updated dependencies [673bb53]
  - @opengeni/contracts@1.4.0
  - @opengeni/network@1.4.0

## 1.3.0

### Patch Changes

- 178b5ae: Unify connector Allow, Ask first and Block decisions across tool transports and settings. Add durable programmatic approval handles, exact stored-operation continuation, and shared review facts with portable React presentation and paginated protected details.

  Add lightweight Gmail message selection and bounded pagination/chunk helpers. Preserve exact access checks, uncertain outcomes and existing client compatibility. Deploy matching API, worker and native runtime artifacts through the documented maintenance migration.

- Updated dependencies [178b5ae]
- Updated dependencies [414d416]
  - @opengeni/contracts@1.3.0
  - @opengeni/network@1.3.0

## 1.2.0

### Patch Changes

- @opengeni/network@1.2.0

## 1.1.0

### Patch Changes

- @opengeni/network@1.1.0

## 1.0.2

### Patch Changes

- @opengeni/network@1.0.1

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

## 0.3.7

### Patch Changes

- aa41b15: Omit Outlook meeting suggestions, which need shared-calendar permissions and do not support personal Microsoft accounts, from the default calendar operation set. Keep calendar, event, and availability operations under the existing OAuth permissions.
- Updated dependencies [3cc26b5]
  - @opengeni/network@0.3.2

## 0.3.6

### Patch Changes

- c60d38a: Include normalized effective OpenAPI operation destinations and the primary manifest URL in immutable revision identity. URL rotation no longer reuses a document-only revision, while equivalent destinations still deduplicate and existing immutable versions and installation fences remain intact.

  Classify known credential Connection rejection at install-time revalidation separately from internal failures. Missing or inaccessible references return 404, and inactive or incompatible references return 422 without weakening ownership, scope, or optimistic-concurrency checks.

## 0.3.5

### Patch Changes

- 6a97313: Publish the curated Integration `autoApproval` governance field and the `autoApprovalForbidden` helper that `@opengeni/api-router` imports.

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
