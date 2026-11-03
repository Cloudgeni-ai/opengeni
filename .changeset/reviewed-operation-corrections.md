---
"@opengeni/capabilities": patch
---

Reviewed OpenAPI definitions can now correct a provider's document declaratively, without new prompt text.

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
