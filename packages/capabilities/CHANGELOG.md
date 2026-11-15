# @opengeni/capabilities

## 6.22.0

### Patch Changes

- Updated dependencies [d50092b]
  - @opengeni/contracts@6.22.0
  - @opengeni/network@6.22.0

## 6.21.0

### Patch Changes

- Updated dependencies [7d0d52b]
- Updated dependencies [ef4c334]
- Updated dependencies [ce864c0]
- Updated dependencies [6ac2cd4]
  - @opengeni/contracts@6.21.0
  - @opengeni/network@6.21.0

## 6.20.1

### Patch Changes

- @opengeni/contracts@6.20.1
- @opengeni/network@6.20.1

## 6.20.0

### Patch Changes

- Updated dependencies [ae3972e]
- Updated dependencies [e37485b]
- Updated dependencies [9c17a87]
  - @opengeni/contracts@6.20.0
  - @opengeni/network@6.20.0

## 6.19.0

### Patch Changes

- Updated dependencies [a85adef]
  - @opengeni/contracts@6.19.0
  - @opengeni/network@6.19.0

## 6.18.0

### Patch Changes

- Updated dependencies [f313a0e]
- Updated dependencies [6813960]
- Updated dependencies [9188c1d]
- Updated dependencies [3105a8b]
- Updated dependencies [a16189c]
- Updated dependencies [89cf4ba]
- Updated dependencies [917393e]
  - @opengeni/contracts@6.18.0
  - @opengeni/network@6.18.0

## 6.17.0

### Patch Changes

- Updated dependencies [8073ab6]
- Updated dependencies [43aa19d]
- Updated dependencies [b1b69fc]
- Updated dependencies [deccb54]
- Updated dependencies [668c5ed]
- Updated dependencies [e3cb3c1]
  - @opengeni/contracts@6.17.0
  - @opengeni/network@6.17.0

## 6.16.0

### Patch Changes

- Updated dependencies [fb19875]
- Updated dependencies [54dc5da]
  - @opengeni/contracts@6.16.0
  - @opengeni/network@6.16.0

## 6.15.0

### Patch Changes

- Updated dependencies [708848c]
- Updated dependencies [5525e63]
- Updated dependencies [60d067d]
- Updated dependencies [da60317]
- Updated dependencies [f92ff08]
- Updated dependencies [060c983]
- Updated dependencies [dfeab20]
- Updated dependencies [9885d37]
- Updated dependencies [f22647a]
- Updated dependencies [850b4d5]
  - @opengeni/contracts@6.15.0
  - @opengeni/network@6.15.0

## 6.14.0

### Patch Changes

- Updated dependencies [c976c87]
- Updated dependencies [6ae0528]
- Updated dependencies [3b853ca]
- Updated dependencies [dd11dad]
- Updated dependencies [91320a4]
- Updated dependencies [c472500]
  - @opengeni/contracts@6.14.0
  - @opengeni/network@6.14.0

## 6.13.0

### Patch Changes

- Updated dependencies [1c7aa2a]
  - @opengeni/contracts@6.13.0
  - @opengeni/network@6.13.0

## 6.12.0

### Patch Changes

- Updated dependencies [64fd53f]
- Updated dependencies [281af3a]
- Updated dependencies [e9222e0]
- Updated dependencies [8cc1ddd]
- Updated dependencies [3929153]
- Updated dependencies [2e1e9c6]
- Updated dependencies [2e749ad]
- Updated dependencies [fcdf7de]
- Updated dependencies [bee1e4c]
- Updated dependencies [913e2b4]
- Updated dependencies [c0b9f88]
- Updated dependencies [00dd24b]
  - @opengeni/contracts@6.12.0
  - @opengeni/network@6.12.0

## 6.11.0

### Minor Changes

- 6abf872: Integration Knowledge sync is fully removed. A migration deletes the leftover Knowledge source sync tasks with their runs, sync state and wakes, and any saved `knowledge_source` facets; Automations no longer show "Sync retired" and the integration facets panel no longer shows "Retired" sources. Native Google Drive and Atlassian source connections left from the old sync stay hidden and inert; the generic connection DELETE still revokes them. Schedules only run agent turns. The native Google Drive and Atlassian source OAuth, callbacks, lifecycle and source routes are gone; Google Drive, OneDrive and Atlassian keep working through their agent-tool connections.

  - Removed internal entry points: `@opengeni/documents/google-drive`, `@opengeni/documents/atlassian` and `@opengeni/contracts/google-drive-native-retirement`. `@opengeni/contracts/knowledge-source-sync-retirement` now exports only `KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE`, and `@opengeni/contracts/atlassian-native-retirement` only the historical tool names.
  - Removed internal `@opengeni/contracts` root exports: `KnowledgeSourceSyncScheduleControl`, `scheduledTaskKnowledgeSource`, `requireScheduledTaskKnowledgeSource` and `knowledgeSourceAgentConfig`.
  - The `OPENGENI_GOOGLE_DRIVE_CLIENT_ID`, `OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET`, `OPENGENI_GOOGLE_DRIVE_SYNC_*`, `OPENGENI_GOOGLE_DRIVE_PROVIDER_*`, `OPENGENI_ATLASSIAN_CLIENT_ID` and `OPENGENI_ATLASSIAN_CLIENT_SECRET` settings are no longer read.
  - Public SDK surface is unchanged until the next major: `browseAtlassianSources`, `saveAtlassianSources`, `setAtlassianLifecycle`, `transitionGoogleDriveLifecycle`, `browseGoogleDriveFacetSource`, `saveGoogleDriveFacetSource`, `disconnectGoogleDriveConnection`, `CreateKnowledgeSourceSyncScheduledTaskRequest`, `agentConfig.knowledgeSource` and `KnowledgeSourceSyncRunSummary` are deprecated. Their routes answer 410, except `disconnectGoogleDriveConnection`, which now revokes through the generic connection DELETE.

### Patch Changes

- 547c03e: Shorter model-facing text for reserved path parameters and the reviewed Outlook and SharePoint search descriptions.
- Updated dependencies [9bb1b56]
- Updated dependencies [7e92bda]
- Updated dependencies [88de211]
- Updated dependencies [5dabaa2]
- Updated dependencies [d8e2bbc]
- Updated dependencies [276001c]
- Updated dependencies [0e8b3b2]
- Updated dependencies [90b961f]
- Updated dependencies [f12070a]
- Updated dependencies [56801f4]
- Updated dependencies [a505ce8]
- Updated dependencies [06606ef]
- Updated dependencies [b05587f]
- Updated dependencies [3345899]
- Updated dependencies [11550b6]
- Updated dependencies [d96bc4d]
- Updated dependencies [650e54a]
- Updated dependencies [7ab60df]
- Updated dependencies [e10e748]
- Updated dependencies [1b8dc89]
- Updated dependencies [7d86f8b]
- Updated dependencies [3f64150]
- Updated dependencies [ba482ea]
- Updated dependencies [6abf872]
- Updated dependencies [b1b8f58]
- Updated dependencies [57748cf]
- Updated dependencies [04d36ce]
  - @opengeni/contracts@6.11.0
  - @opengeni/network@6.11.0

## 6.10.0

### Minor Changes

- 3cb57d8: `tool_search` now offers the Connect card for an integration the query names even when an unrelated installed tool matches strongly, such as a Slack bot tool for "posts on Slack" or meeting search for "Linear issues". The integration catalog lookup is skipped only when a strong match is that integration's own tool; ownership by a shared vendor domain also needs agreeing names, so a Microsoft Teams tool does not hide Microsoft Excel. Beside strong matches the catalog is read only when the query has a capitalised word mid-sentence or a word no installed tool uses, the search waits for it at most 1.5 seconds, and only a distinctive mention names an integration, so "close the ticket" or "linear regression" add no card.

  Integration names are also recognised with different spacing or case ("hub spot", "wisprflow"), as near spellings ("whisperflow" for Wispr Flow, "hubsopt" for HubSpot), and by the vendor's word in its registrable domain ("jira" for Atlassian at jira.com) when that domain is one product's ("microsoft" names none of Teams, Excel and OneDrive). Common words close to a name ("email" for Gmail, "conference" for Confluence), plurals ("snowflakes") and compound phrases ("linked in", "the last pass") do not name one. `@opengeni/capabilities` exports the shared matching (`integrationMentionsIn`, `integrationMentionMatcher`, `isDistinctiveIntegrationMention`, `isIntegrationNearSpelling`, `integrationVendorWord`, `integrationQueryWords`, `integrationNamesAgree`, `sharedVendorDomains`, `registrableHostDomain`), and capability catalog search ranks entries a query names distinctively above entries that only share its ordinary words ("send a message" does not promote Send). Entries whose names agree with a named entry share its rank, so naming "GitHub" keeps GitHub App above the GitHub plugin.

### Patch Changes

- 168d812: Generated OpenAPI integrations now read files whose download redirects. A safe read (GET or HEAD) follows at most three https redirects, such as Microsoft Graph `/content` to its pre-signed download URL, through the same pinned transport and one shared deadline, without the Authorization header, credential cookies or credential query parameters. A redirect target's own 401 or 403 (an expired link) is returned as the provider's result rather than as a lost authorization. A mutation's redirect is still rejected and its outcome stays unknown. Response bytes that are not UTF-8 (PDFs, images, Word, Excel and PowerPoint files) come back as base64 instead of replacement characters, up to 2 MiB; larger binary reports its size. A body over the response limit is a recoverable `response_too_large` error.

  A generated integration call that fails with a known outcome (a rejected redirect, a missing path parameter, an authorization the provider refused) now reaches the model as an ordinary tool error, `{"ok":false,"error":{"code","message","status","retryable"}}`, on every server. It is no longer reported as a tool that is unavailable for the rest of the turn. A missing path parameter's error names the parameter.

- c672cf7: Reviewed OpenAPI definitions can now correct a provider's document declaratively, without new prompt text.

  - `requestPath` sends a reviewed operation to a different path while it keeps its tool identity. `{+name}` in it expands a path parameter as a path (RFC 6570 reserved expansion, marked as `allowReserved` on the binding): each segment is encoded once (an already percent-encoded segment is decoded first), `/` is kept, extra slashes are dropped, a `.` or `..` segment is refused as a recoverable error, and the parameter gets generic path guidance. A request path that lands on a path another operation uses is merged with it.
  - `omitQueryParameters` drops query parameters the provider documents but rejects, including ones declared for the whole path.
  - Any path parameter whose value is `.`, `..` or invalid Unicode is now a recoverable `parameter_invalid` error.
  - `operationText` replaces a prefix-selected operation's summary and description when the provider's text describes a different operation.

  These Microsoft definitions use the new fields:

  - SharePoint's site lookup by path now uses Graph's colon form, `/sites/{hostname}:/{path}`, which Graph accepts. Previously it sent an encoded `getByPath(path='%2Fsites%2Fhr')`, which Graph rejected with "Error in query syntax".
  - Teams channel messages offer only `$top`, `$select`, `$expand` and paging, not `$orderby`, `$skip`, `$search`, `$filter` or `$count`, which Graph doesn't support there.
  - Outlook's list, create-draft, get, update and delete message operations, and the MIME content operations, get correct names and descriptions instead of Graph's open-extension and eventMessage text.
  - The SharePoint and Teams search descriptions now say to send one entry in `requests` per call, because Graph v1.0 rejects several.

  Installed integrations adopt these changes when their definition is refreshed.

- f0d27b2: One connector's bad tool no longer stops a turn. When a connector lists the same tool more than once (as the ElevenLabs hosted MCP did while its tool list changed), Opengeni keeps one copy. Two different tools that would share a Codemode path now get distinct paths, and a tool that still cannot be added, or whose definition is invalid, is left out for that turn. Each case is logged as a structured warning. A call always runs the tool the model was shown: when two different tools claim one model name, the catalog keeps one, and a call meant for the other is refused rather than sent to the wrong tool. OpenAPI connectors whose operation names differ only by a number suffix keep a separate tool for each operation.
- Updated dependencies [c9e5547]
- Updated dependencies [a143aaf]
- Updated dependencies [fb37d99]
- Updated dependencies [4fc9529]
- Updated dependencies [b5201d5]
- Updated dependencies [b089060]
- Updated dependencies [116acad]
- Updated dependencies [e551a50]
- Updated dependencies [f45ab2f]
- Updated dependencies [9cf9b58]
- Updated dependencies [d717b72]
  - @opengeni/contracts@6.10.0
  - @opengeni/network@6.10.0

## 6.9.0

### Patch Changes

- Updated dependencies [8572155]
- Updated dependencies [54bf495]
  - @opengeni/contracts@6.9.0
  - @opengeni/network@6.9.0

## 6.8.0

### Patch Changes

- Updated dependencies [58b04d1]
- Updated dependencies [feaecf8]
  - @opengeni/contracts@6.8.0
  - @opengeni/network@6.8.0

## 6.7.0

### Patch Changes

- Updated dependencies [c08233e]
- Updated dependencies [57237db]
- Updated dependencies [cf35731]
- Updated dependencies [4a7da4c]
  - @opengeni/contracts@6.7.0
  - @opengeni/network@6.7.0

## 6.6.0

### Patch Changes

- Updated dependencies [2c76a2a]
- Updated dependencies [09bc485]
- Updated dependencies [2e72a00]
- Updated dependencies [029497c]
- Updated dependencies [3cb05f9]
  - @opengeni/contracts@6.6.0
  - @opengeni/network@6.6.0

## 6.5.1

### Patch Changes

- 7de2adf: Connector cards show a well-known service's own name and logo instead of its raw hostname and a letter, for example "Google Search Console" with its mark and a "Connect Google Search Console" button. The catalog overlay gains `identities` (name, logo and homepage only) for 164 services including every Google API row, and generated letter placeholders from integrations.sh are screened out so the product's own monogram shows instead. `validateLogoAsset` rejects such placeholders when called with `rejectGeneratedPlaceholder` (the catalog import and vendoring paths); a custom MCP server's own declared icon is accepted as before. A re-import clears a stored catalog logo once its row has no logo by policy (`RegistryCapabilityCatalogItemInput.clearLogoAsset`). The setup card no longer repeats a subtitle identical to its title. The SharePoint and OneDrive setup cards show their Microsoft marks instead of a letter, like Teams and Outlook already did.
- Updated dependencies [f1998df]
- Updated dependencies [3f9ef93]
- Updated dependencies [ebfd447]
- Updated dependencies [7a9c492]
- Updated dependencies [468e8c3]
- Updated dependencies [e4484f1]
- Updated dependencies [7f3d037]
- Updated dependencies [f4f82c0]
- Updated dependencies [317fb4d]
- Updated dependencies [033cd63]
- Updated dependencies [b18bd6c]
- Updated dependencies [83ccc2b]
- Updated dependencies [da9b7e5]
- Updated dependencies [0f7f559]
- Updated dependencies [0f7f559]
- Updated dependencies [de8fc61]
- Updated dependencies [dd7759c]
- Updated dependencies [70c726c]
- Updated dependencies [4682263]
- Updated dependencies [52c8c3b]
- Updated dependencies [52c8c3b]
- Updated dependencies [52c8c3b]
- Updated dependencies [abb4af1]
- Updated dependencies [86e35f1]
- Updated dependencies [0f7f559]
  - @opengeni/contracts@6.5.0
  - @opengeni/network@6.5.0

## 6.4.0

### Patch Changes

- cfce969: Integration Knowledge sync is retired. Integrations give agents tools and access; for recurring work, create an ordinary agent schedule that uses the integration's tools.

  - Google Drive and OneDrive no longer offer a "Knowledge source" (`drive-content`) facet. Configuring a `knowledge_source` facet, or browsing or saving a source, returns 410.
  - Creating a schedule with `agentConfig.knowledgeSource`, or changing a saved task's source, returns 410.
  - Saved source tasks (a `knowledge_source_sync` action or `agentConfig.knowledgeSource`) for any provider now read as retired. Fires, manual runs and resume are refused, and queued runs fail with `knowledge_source_sync_retired`. Google Drive and Atlassian tasks keep their existing retirement reasons. You can still read and delete these tasks.
  - The worker no longer contains the source sync workflow, its activities, or the `knowledge_source_fetch` and `knowledge_source_read` attempt tools.
  - New in `@opengeni/contracts/knowledge-source-sync-retirement`: `retiredKnowledgeSourceSyncTask`, `isRetiredKnowledgeSourceSyncTask` and the shared retirement reasons. `isRetiredNativeGoogleDriveTask` and `isRetiredNativeAtlassianTask` are deprecated.
  - Imported Documents, Knowledge entries, source provenance and run history stay readable. Public schemas and SDK types are unchanged, and no data or tables are removed.

- Updated dependencies [1f918a4]
- Updated dependencies [000c023]
- Updated dependencies [bc5c6d5]
- Updated dependencies [06adef4]
- Updated dependencies [ace882b]
- Updated dependencies [dcb2352]
- Updated dependencies [894121c]
- Updated dependencies [f3e6835]
- Updated dependencies [0b19c29]
- Updated dependencies [b098518]
- Updated dependencies [a99a7d6]
- Updated dependencies [c2f978b]
- Updated dependencies [c59d7f8]
- Updated dependencies [237329e]
- Updated dependencies [bf3cf84]
- Updated dependencies [cdb9d27]
- Updated dependencies [cfce969]
- Updated dependencies [df44bd8]
- Updated dependencies [4bd54f1]
- Updated dependencies [3b9a997]
- Updated dependencies [1efa378]
- Updated dependencies [237329e]
- Updated dependencies [af8a173]
  - @opengeni/contracts@6.4.0
  - @opengeni/network@6.4.0

## 6.3.1

### Patch Changes

- Updated dependencies [d5db2de]
- Updated dependencies [d91058a]
- Updated dependencies [b5c112c]
- Updated dependencies [32bc3e9]
- Updated dependencies [923c161]
- Updated dependencies [ced76d5]
- Updated dependencies [40b79c9]
- Updated dependencies [d872b12]
- Updated dependencies [c35704f]
- Updated dependencies [008d073]
- Updated dependencies [d0295f8]
- Updated dependencies [e8b24d1]
- Updated dependencies [f4ad926]
- Updated dependencies [e53c5ad]
- Updated dependencies [a550481]
- Updated dependencies [af8fb16]
- Updated dependencies [139a2be]
- Updated dependencies [1afdda0]
  - @opengeni/contracts@6.3.0
  - @opengeni/network@6.3.0

## 6.2.1

### Patch Changes

- Updated dependencies [cbfd911]
- Updated dependencies [7c94b6e]
- Updated dependencies [7af3643]
  - @opengeni/contracts@6.2.0
  - @opengeni/network@6.2.0

## 6.1.1

### Patch Changes

- Updated dependencies [0422c7b]
- Updated dependencies [9f02c05]
- Updated dependencies [6573dc7]
- Updated dependencies [9cf4bc0]
  - @opengeni/contracts@6.1.0
  - @opengeni/network@6.1.0

## 6.0.2

### Minor Changes

- 755adaf: Agents can look up colleagues with a work or school Microsoft 365 account: SharePoint and Teams can search the organization directory and read a colleague's profile and direct reports. SharePoint requests basic profiles (User.ReadBasic.All, no administrator consent). Teams requests User.Read.All, which adds job title, department and manager lookups. Teams can also search chat and channel messages with Microsoft Search, limited to Teams messages, without asking for approval. Existing Teams connections need to reconnect, with administrator consent, to use the new tools.
- 4246602: Add a SharePoint integration for work and school Microsoft 365 accounts: search SharePoint content, find sites, browse document libraries and read files, read lists, and add or update list items with review. Microsoft Search is a reviewed read limited to file, list and site results, so searching never asks for approval and cannot reach mail, calendar or chats. Reviewed read-only overrides are part of the revision identity. OneDrive and Outlook Contacts consent screens now label only the permissions they actually request. The Atlassian and Google Drive catalog entries are marked as verified vendor-hosted servers, and Atlassian gets consent copy and admin guidance for allowing the Opengeni domain.

### Patch Changes

- b5e61c5: Honor OpenAPI form query arrays with explode:false, including Microsoft Graph $select, $expand and $orderby, instead of repeating the query option. Refresh existing integration catalogs to adopt the corrected immutable bindings; previously accepted revisions stay unchanged.
- 4b0dd0b: Approval cards for long HTML emails now list every link target the reader doesn't show in full, however long the message is: a "Links:" line leads the preview, and past its limit it says "Details lists every link": the message's Details now lead with every link target, one per row. Link addresses decode exactly as a browser does (every named reference, numeric references without a semicolon), a form's submit destination counts as a link, and paragraph and line breaks read as breaks. Operation titles: Stripe-style ids such as `PostChargesChargeCapture` read "Capture charge", and `users.user.sendMail` reads "Send an email".

  The integration Connect card keeps every line true: when it can no longer see the sign-in window while waiting (closed, or cut off by the provider's page, as Google's sign-in pages do) it keeps waiting and says "Finish signing in to {name}. If you closed the sign-in window, open it again." with an Open sign-in window button, the "You can close the sign-in window." reminder goes once the window closes, and keyboard focus stays on the card after connecting. The code step reads in order (code, a button-styled "Open the sign-in page", then what to do there) on web and phone, and "Waiting for authorization" now reads "Waiting for you to sign in".

- Updated dependencies [e1ebd25]
- Updated dependencies [44ba53b]
- Updated dependencies [d4fd76d]
- Updated dependencies [f385091]
- Updated dependencies [7a5395e]
- Updated dependencies [aa6b340]
- Updated dependencies [12b773f]
- Updated dependencies [7f627c9]
- Updated dependencies [e8bc121]
- Updated dependencies [ecc876a]
- Updated dependencies [f6c6c0f]
- Updated dependencies [09972b5]
- Updated dependencies [cebc433]
- Updated dependencies [0ba40f0]
- Updated dependencies [449bcae]
- Updated dependencies [37538aa]
- Updated dependencies [c6ba725]
- Updated dependencies [5a3ed41]
- Updated dependencies [a02dca4]
- Updated dependencies [a1a060b]
- Updated dependencies [60c6c56]
- Updated dependencies [177de8d]
- Updated dependencies [d166d88]
- Updated dependencies [66d1e08]
- Updated dependencies [6c5a6b5]
- Updated dependencies [21856c5]
- Updated dependencies [4b0dd0b]
- Updated dependencies [3c0113c]
- Updated dependencies [71bcf11]
- Updated dependencies [942fcc1]
- Updated dependencies [fb41dfd]
- Updated dependencies [31e07a6]
- Updated dependencies [a744c56]
- Updated dependencies [a895f0b]
- Updated dependencies [b0f7062]
- Updated dependencies [670913f]
- Updated dependencies [3aaf6ed]
- Updated dependencies [0f77b2d]
- Updated dependencies [77f483f]
- Updated dependencies [a1e75dc]
- Updated dependencies [5cab358]
- Updated dependencies [35387c2]
- Updated dependencies [149a15c]
  - @opengeni/contracts@6.0.0
  - @opengeni/network@6.0.0

## 5.5.1

### Patch Changes

- Updated dependencies [23fb6ef]
- Updated dependencies [f23588a]
- Updated dependencies [1600e2d]
- Updated dependencies [e555018]
- Updated dependencies [22b129b]
- Updated dependencies [a4b57e6]
- Updated dependencies [729329e]
- Updated dependencies [e473f84]
- Updated dependencies [4a86d4d]
- Updated dependencies [220c431]
- Updated dependencies [d569481]
- Updated dependencies [8382bdb]
- Updated dependencies [fbcc3cd]
- Updated dependencies [18c7cfa]
- Updated dependencies [b1673ab]
- Updated dependencies [b56bf3f]
- Updated dependencies [031e173]
- Updated dependencies [81502bb]
- Updated dependencies [9c8a5d5]
  - @opengeni/contracts@5.5.0
  - @opengeni/network@5.5.0

## 5.4.2

### Minor Changes

- 801743c: A connected MCP server's own icon now shows as its connector logo. When a workspace connects or enables its own (custom) MCP server, Opengeni reads the `icons` the server lists in its `initialize` reply (`serverInfo.icons`, MCP 2025-11-25), picks the best one for a single tile (theme-neutral before light or dark, vector before a large raster, favicons last), and stores it as the item's logo. Icons go through the same checks as vendored catalog logos (an image type the asset route serves, at most 512 KB, no scripts or external references in SVGs), are fetched through the deployment's outbound network policy with a timeout and at most three redirects, and are served from `/v1/catalog-assets/...`, so the browser never loads them from the server's host. A server without a usable icon keeps its monogram and connects as before. Tool steps from such a server also find the logo by the server's host. Editing a custom catalog item no longer clears its logo. New `@opengeni/capabilities` exports: `mcpServerIcons`, `rankMcpServerIcons`, `decodeDataUriIcon`, `validateLogoAsset`, `catalogAssetObjectKey` and the other logo-asset checks previously private to the catalog scripts; new `@opengeni/db` export `setWorkspaceCapabilityCatalogItemLogo`.

### Patch Changes

- Updated dependencies [931325b]
- Updated dependencies [d649005]
- Updated dependencies [5aa883b]
- Updated dependencies [a57cfa8]
- Updated dependencies [4488c59]
- Updated dependencies [5a48fe7]
- Updated dependencies [3ee89da]
- Updated dependencies [f6298be]
- Updated dependencies [58d272f]
- Updated dependencies [01188c9]
- Updated dependencies [995c16f]
- Updated dependencies [53e1fe5]
- Updated dependencies [d30a243]
- Updated dependencies [659f5a4]
- Updated dependencies [5b9feb9]
- Updated dependencies [de7087a]
- Updated dependencies [cb15454]
- Updated dependencies [a8b429e]
- Updated dependencies [57cfc37]
- Updated dependencies [f20b8fb]
- Updated dependencies [96502c5]
- Updated dependencies [5f332c1]
- Updated dependencies [24b71c6]
- Updated dependencies [54c2f9e]
- Updated dependencies [936d9e0]
- Updated dependencies [4651b0d]
- Updated dependencies [30b9cd2]
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
